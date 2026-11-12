package com.physicalcloud

import android.content.Context
import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.util.Base64
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/** Reserva um nome livre usando criação exclusiva atômica do filesystem. */
private fun reservarArquivoDownloadsAtomic(dir: File, safeName: String): File? {
    var index = 0
    while (index < 10000) {
        val dot = safeName.lastIndexOf('.')
        val candidateName = if (index == 0) safeName else if (dot > 0) {
            safeName.substring(0, dot) + " ($index)" + safeName.substring(dot)
        } else "$safeName ($index)"
        val candidate = File(dir, candidateName)
        val created = try { candidate.createNewFile() } catch (e: Exception) {
            if (candidate.exists()) false else throw e
        }
        if (created) return candidate
        index++
    }
    return null
}

/**
 * Bridge entre o JavaScript da WebView e o código nativo Android.
 * Cada método @JavascriptInterface é acessível como AndroidBridge.nomeDaFuncao() no JS.
 */
class PhysicalCloudBridge(private val activity: MainActivity) {

    // ─── Mapa de streams abertos (Bloco 1: escrita em streaming) ──────────
    // Chave: URI do arquivo recém-criado (string). Valor: OutputStream aberto.
    private val openStreams = ConcurrentHashMap<String, OutputStream>()

    // ─── Mapa de streams de LEITURA (Fix 1: leitura incremental) ──────────
    // Evita OOM ao ler arquivos grandes compartilhados via Intent.
    private val openReadStreams = ConcurrentHashMap<String, InputStream>()
    private val pendingMediaDownloads = ConcurrentHashMap.newKeySet<String>()
    private val legacyDownloadPaths = ConcurrentHashMap.newKeySet<String>()

    // Armazena hashes de ID e revogações pendentes cifrados com chave não exportável
    // do Android Keystore, independentemente do ID local exibido ao usuário.
    private val securePrefs by lazy { activity.getSharedPreferences("pc_secure_store", Context.MODE_PRIVATE) }
    private val secureKeyAlias = "physicalcloud_local_secret_v1"

    private fun secureKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(secureKeyAlias, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                secureKeyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    @JavascriptInterface
    fun secureStoreGet(key: String): String? {
        if (!isAllowedSecureKey(key)) return null
        val packed = securePrefs.getString(key, null) ?: return null
        return try {
            val parts = packed.split(":", limit = 2)
            if (parts.size != 2) throw IllegalArgumentException("Formato cifrado inválido")
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secureKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "Não foi possível ler o dado seguro '$key'; removendo valor ilegível.", e)
            securePrefs.edit().remove(key).apply()
            null
        }
    }

    @JavascriptInterface
    fun secureStoreSet(key: String, value: String): Boolean {
        if (!isAllowedSecureKey(key) || value.length > 20000) return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secureKey())
            val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP)
            securePrefs.edit().putString(key, packed).commit()
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao gravar dado seguro '$key'.", e)
            false
        }
    }

    @JavascriptInterface
    fun secureStoreRemove(key: String): Boolean {
        if (!isAllowedSecureKey(key)) return false
        return securePrefs.edit().remove(key).commit()
    }

    private fun isAllowedSecureKey(key: String): Boolean = key in setOf(
        "physicalCloudAutoIdHash",
        "physicalCloudAutoRevocationsPending",
        "physicalCloudAutoIdLegacyToRevoke"
    )

    companion object {
        private const val TAG = "PCBridge"
        // Limite para leitura direta (readFileAsBase64): 50 MB.
        // Acima disso, o JS deve usar openReadStream + readStreamChunk.
        private const val MAX_DIRECT_READ_BYTES = 50L * 1024 * 1024
        private const val MAX_STREAM_CHUNK_BYTES = 1024 * 1024
        private val SAF_FILE_CREATE_LOCK = Any()
    }

    /**
     * Cria um arquivo SAF com nome livre, incluindo colisões de diretórios.
     * A seção crítica é compartilhada entre instâncias da bridge no mesmo processo.
     * O nome é conferido novamente após createFile, pois alguns DocumentProviders
     * podem normalizar ou alterar o nome solicitado.
     */
    private fun criarArquivoSafComNomeLivre(
        pasta: DocumentFile,
        mimeType: String,
        nomeSolicitado: String
    ): DocumentFile? = synchronized(SAF_FILE_CREATE_LOCK) {
        val nomeBase = sanitizeFileName(nomeSolicitado).ifBlank { "arquivo" }
        val ponto = nomeBase.lastIndexOf('.')
        val base = if (ponto > 0) nomeBase.substring(0, ponto) else nomeBase
        val extensao = if (ponto > 0) nomeBase.substring(ponto) else ""
        val nomesExistentes = pasta.listFiles()
            .mapNotNull { it.name?.lowercase(Locale.ROOT) }
            .toMutableSet()

        for (indice in 0 until 10000) {
            val candidato = if (indice == 0) nomeBase else {
                val sufixo = " ($indice)"
                val tamanhoBaseMaximo = (255 - sufixo.length - extensao.length).coerceAtLeast(1)
                base.take(tamanhoBaseMaximo) + sufixo + extensao
            }
            if (candidato.lowercase(Locale.ROOT) in nomesExistentes) continue

            val criado = pasta.createFile(mimeType, candidato) ?: continue
            val nomeReal = criado.name?.takeIf { it.isNotBlank() } ?: candidato
            val colisaoPosterior = pasta.listFiles().any { outro ->
                outro.uri != criado.uri && outro.name?.equals(nomeReal, ignoreCase = true) == true
            }
            if (!colisaoPosterior) return@synchronized criado

            // Não deixa um item ambíguo recém-criado na pasta.
            try { criado.delete() } catch (_: Exception) {}
            nomesExistentes.add(nomeReal.lowercase(Locale.ROOT))
            nomesExistentes.add(candidato.lowercase(Locale.ROOT))
        }
        null
    }

    // ─── Informações do dispositivo ────────────────────────────────────────

    @JavascriptInterface
    fun getDeviceInfo(): String {
        val info = JSONObject().apply {
            put("isApp", true)
            put("platform", "android")
            put("sdkVersion", Build.VERSION.SDK_INT)
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
        }
        return info.toString()
    }

    @JavascriptInterface
    fun getDeviceName(): String {
        return "${Build.MANUFACTURER} ${Build.MODEL}"
    }

    // ─── Toast nativo ─────────────────────────────────────────────────────

    @JavascriptInterface
    fun showToast(message: String) {
        activity.runOnUiThread {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }

    // ─── Seletor de pasta nativo (SAF) ────────────────────────────────────

    @JavascriptInterface
    fun openFolderPicker(callbackName: String) {
        if (callbackName.length > 100) return
        activity.runOnUiThread {
            activity.openFolderPicker { uri ->
                // JSONObject faz o escape correto de aspas, barras e caracteres de controle.
                val detail = JSONObject().apply {
                    put("uri", uri?.toString() ?: JSONObject.NULL)
                    put("callbackName", callbackName)
                }
                val js = "window.dispatchEvent(new CustomEvent('android:folder-picked', { detail: $detail }));"
                activity.runOnUiThread {
                    activity.findViewById<android.webkit.WebView>(R.id.webView)
                        ?.evaluateJavascript(js, null)
                }
            }
        }
    }

    // ─── BLOCO 1: Escrita em stream (evita OOM em arquivos grandes) ────────

    /**
     * Cria o arquivo na pasta escolhida e abre um OutputStream persistente.
     * Retorna o URI do arquivo criado (usado como "handle" nas chamadas seguintes).
     */
    private fun resolveTreeDirectory(treeUri: Uri, relativePathJson: String, create: Boolean): DocumentFile? {
        var directory = DocumentFile.fromTreeUri(activity, treeUri) ?: return null
        val parts = try { JSONArray(relativePathJson) } catch (_: Exception) { JSONArray() }
        for (i in 0 until parts.length()) {
            val name = parts.optString(i, "")
            if (name.isBlank() || name == "." || name == ".." || name.contains("/") || name.contains("\\")) return null
            var child = directory.findFile(name)
            if (child == null && create) child = directory.createDirectory(name)
            if (child == null || !child.isDirectory) return null
            directory = child
        }
        return directory
    }

    @JavascriptInterface
    fun startFileWrite(fileName: String, folderUriStr: String, relativePathJson: String = "[]"): String {
        return try {
            val folderUri = Uri.parse(folderUriStr)
            val docFolder = resolveTreeDirectory(folderUri, relativePathJson, true)
                ?: return resultError("Pasta inválida ou subpasta indisponível")

            val safeFileName = sanitizeFileName(fileName)
            val mimeType = guessMimeType(safeFileName)
            val newFile = criarArquivoSafComNomeLivre(docFolder, mimeType, safeFileName)
                ?: return resultError("Não foi possível reservar um nome livre na pasta selecionada")
            val nomeFinal = newFile.name?.takeIf { it.isNotBlank() } ?: safeFileName

            val stream = activity.contentResolver.openOutputStream(newFile.uri)
                ?: run { newFile.delete(); return resultError("Não foi possível abrir stream de escrita") }

            val fileUriStr = newFile.uri.toString()
            openStreams[fileUriStr] = stream

            Log.d(TAG, "Stream de escrita aberto: $nomeFinal -> $fileUriStr")
            resultSuccess(mapOf("fileUri" to fileUriStr, "streamKey" to fileUriStr, "name" to nomeFinal))
        } catch (e: Exception) {
            Log.e(TAG, "Erro em startFileWrite", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    /**
     * Abre um arquivo progressivo na pasta Downloads do usuário.
     * Android 10+ usa MediaStore/IS_PENDING; versões anteriores usam Downloads público.
     */
    @JavascriptInterface
    fun startDownloadWrite(fileName: String, mimeType: String, relativeFolder: String = ""): String {
        return try {
            val safeName = sanitizeFileName(fileName)
            val safeMime = mimeType.ifEmpty { guessMimeType(safeName) }
            val safeFolders = relativeFolder.split("/", "\\").filter { it.isNotBlank() && it != "." && it != ".." }.map { sanitizeFileName(it) }
            val relativeDownloadPath = (listOf(Environment.DIRECTORY_DOWNLOADS, "Physical Cloud") + safeFolders).joinToString("/")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                    put(MediaStore.MediaColumns.MIME_TYPE, safeMime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, relativeDownloadPath)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return resultError("Não foi possível criar o arquivo em Downloads")
                val stream = activity.contentResolver.openOutputStream(uri, "w")
                if (stream == null) {
                    activity.contentResolver.delete(uri, null, null)
                    return resultError("Não foi possível abrir o arquivo em Downloads")
                }
                val key = uri.toString()
                openStreams[key] = stream
                pendingMediaDownloads.add(key)
                resultSuccess(mapOf("fileUri" to key, "streamKey" to key, "name" to safeName))
            } else {
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), (listOf("Physical Cloud") + safeFolders).joinToString(File.separator))
                if (!dir.exists() && !dir.mkdirs()) return resultError("Não foi possível acessar Downloads")
                // createNewFile reserva o caminho atomically no filesystem.
                val file = reservarArquivoDownloadsAtomic(dir, safeName)
                    ?: return resultError("Não foi possível reservar um nome livre em Downloads")
                val key = file.absolutePath
                try {
                    val stream = FileOutputStream(file, false)
                    val anterior = openStreams.putIfAbsent(key, stream)
                    if (anterior != null) {
                        stream.close()
                        file.delete()
                        return resultError("Já existe uma gravação em andamento com esse destino")
                    }
                    legacyDownloadPaths.add(key)
                    resultSuccess(mapOf("fileUri" to key, "streamKey" to key, "name" to file.name))
                } catch (e: Exception) {
                    openStreams.remove(key)?.let { try { it.close() } catch (_: Exception) {} }
                    legacyDownloadPaths.remove(key)
                    file.delete()
                    throw e
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Erro em startDownloadWrite", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    /**
     * Grava um chunk base64 no stream aberto por startFileWrite.
     * Retorna {"success": true} ou {"success": false, "error": "..."}.
     */
    @JavascriptInterface
    fun appendChunk(fileUriStr: String, base64Chunk: String): String {
        return try {
            val stream = openStreams[fileUriStr]
                ?: return resultError("Stream não encontrado para $fileUriStr")

            val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
            stream.write(bytes)
            resultSuccess(mapOf("written" to bytes.size))
        } catch (e: Exception) {
            Log.e(TAG, "Erro em appendChunk", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    /**
     * Fecha o stream e remove do mapa. Deve ser chamado ao fim da transferência.
     */
    @JavascriptInterface
    fun finishFileWrite(fileUriStr: String): String {
        return try {
            val stream = openStreams.remove(fileUriStr)
                ?: return resultError("Stream não encontrado para $fileUriStr")
            stream.flush()
            stream.close()

            if (pendingMediaDownloads.contains(fileUriStr)) {
                val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                val updated = activity.contentResolver.update(Uri.parse(fileUriStr), values, null, null)
                if (updated <= 0) return resultError("O arquivo foi gravado, mas não pôde ser publicado em Downloads")
                pendingMediaDownloads.remove(fileUriStr)
            } else if (legacyDownloadPaths.remove(fileUriStr)) {
                MediaScannerConnection.scanFile(activity, arrayOf(fileUriStr), null, null)
            }
            Log.d(TAG, "Stream de escrita fechado: $fileUriStr")
            resultSuccess(mapOf("uri" to fileUriStr))
        } catch (e: Exception) {
            Log.e(TAG, "Erro em finishFileWrite", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    /** Fecha e remove um arquivo parcial quando a transferência falha/cancela. */
    @JavascriptInterface
    fun abortFileWrite(fileUriStr: String): String {
        return try {
            try { openStreams.remove(fileUriStr)?.close() } catch (_: Exception) {}
            if (pendingMediaDownloads.remove(fileUriStr)) {
                activity.contentResolver.delete(Uri.parse(fileUriStr), null, null)
            } else if (legacyDownloadPaths.remove(fileUriStr)) {
                File(fileUriStr).delete()
            } else {
                try { DocumentsContract.deleteDocument(activity.contentResolver, Uri.parse(fileUriStr)) }
                catch (_: Exception) { try { DocumentFile.fromSingleUri(activity, Uri.parse(fileUriStr))?.delete() } catch (_: Exception) {} }
            }
            resultSuccess(emptyMap())
        } catch (e: Exception) {
            Log.e(TAG, "Erro em abortFileWrite", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── Salvar arquivo recebido (base64 completo — mantido para compatibilidade) ──

    @JavascriptInterface
    fun saveFile(base64Data: String, fileName: String, mimeType: String, folderUriStr: String): String {
        return try {
            val folderUri = Uri.parse(folderUriStr)
            val docFolder = DocumentFile.fromTreeUri(activity, folderUri)
                ?: return resultError("Pasta inválida")

            val safeFileName = sanitizeFileName(fileName)
            val newFile = criarArquivoSafComNomeLivre(docFolder, mimeType.ifEmpty { "*/*" }, safeFileName)
                ?: return resultError("Não foi possível reservar um nome livre na pasta selecionada")
            val nomeFinal = newFile.name?.takeIf { it.isNotBlank() } ?: safeFileName

            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                activity.contentResolver.openOutputStream(newFile.uri)?.use { out ->
                    out.write(bytes)
                } ?: throw IllegalStateException("Não foi possível abrir o stream de escrita")
                Log.d(TAG, "Arquivo salvo: $nomeFinal (${bytes.size} bytes) em $folderUriStr")
                resultSuccess(mapOf("uri" to newFile.uri.toString(), "name" to nomeFinal))
            } catch (e: Exception) {
                try { newFile.delete() } catch (_: Exception) {}
                throw e
            }
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao salvar arquivo", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── BLOCO 4: Listagem de diretório via SAF ────────────────────────────

    /**
     * Lista os arquivos de uma pasta SAF.
     * Retorna JSON: { success: true, files: [ { name, uri, mimeType, size, isDirectory } ] }
     */
    @JavascriptInterface
    fun listDirectoryFiles(folderUriStr: String, relativePathJson: String = "[]"): String {
        return try {
            val folderUri = Uri.parse(folderUriStr)
            val docFolder = resolveTreeDirectory(folderUri, relativePathJson, false)
                ?: return resultError("Pasta inválida ou permissão negada")

            val filesArray = JSONArray()
            for (child in docFolder.listFiles()) {
                val obj = JSONObject().apply {
                    put("name", child.name ?: "desconhecido")
                    put("uri", child.uri.toString())
                    put("mimeType", child.type ?: if (child.isDirectory) "inode/directory" else "application/octet-stream")
                    put("size", child.length())
                    put("isDirectory", child.isDirectory)
                    put("lastModified", child.lastModified())
                }
                filesArray.put(obj)
            }

            val result = JSONObject().apply {
                put("success", true)
                put("files", filesArray)
                put("folderName", docFolder.name ?: "pasta")
            }
            result.toString()
        } catch (e: Exception) {
            Log.e(TAG, "Erro em listDirectoryFiles", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── Salvar arquivo na pasta Downloads (fallback sem SAF) ─────────────

    @JavascriptInterface
    fun saveFileToDownloads(base64Data: String, fileName: String): String {
        return try {
            val safeFileName = sanitizeFileName(fileName)
            val downloadsDir = Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DOWNLOADS
            )
            downloadsDir.mkdirs()

            if (!downloadsDir.exists() && !downloadsDir.mkdirs()) {
                return resultError("Não foi possível acessar Downloads")
            }
            // A reserva é atômica: duas gravações concorrentes nunca escolhem o mesmo nome.
            val destFile = reservarArquivoDownloadsAtomic(downloadsDir, safeFileName)
                ?: return resultError("Não foi possível reservar um nome livre em Downloads")

            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                FileOutputStream(destFile, false).use { it.write(bytes) }
            } catch (e: Exception) {
                // Remove apenas o arquivo que esta chamada reservou.
                destFile.delete()
                throw e
            }

            // FIX 4: ACTION_MEDIA_SCANNER_SCAN_FILE está deprecated desde API 19.
            // MediaScannerConnection é a API correta para Android moderno.
            MediaScannerConnection.scanFile(
                activity, arrayOf(destFile.absolutePath), null, null
            )

            Log.d(TAG, "Salvo em Downloads: ${destFile.name}")
            resultSuccess(mapOf("path" to destFile.absolutePath, "name" to destFile.name))
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao salvar em Downloads", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── Verificar/pedir isenção de bateria ───────────────────────────────

    @JavascriptInterface
    fun requestNotificationPermissionForAutoMode() {
        activity.requestNotificationPermissionForAutoMode()
    }

    @JavascriptInterface
    fun requestBatteryExemption() {
        activity.openBatteryOptimizationRequest()
    }

    @JavascriptInterface
    fun isBatteryOptimizationIgnored(): Boolean {
        val pm = activity.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        return pm.isIgnoringBatteryOptimizations(activity.packageName)
    }

    // ─── Estado persistente do modo automático ────────────────────────────
    @JavascriptInterface
    fun setAutoModeActive(active: Boolean) {
        activity.getSharedPreferences("pc_prefs", Context.MODE_PRIVATE)
            .edit().putBoolean("auto_mode_active", active).commit()
        try {
            val intent = Intent(activity, PhysicalCloudService::class.java).apply {
                action = PhysicalCloudService.ACTION_UPDATE_AUTO_MODE
                putExtra(PhysicalCloudService.EXTRA_AUTO_MODE_ACTIVE, active)
            }
            activity.startService(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Não foi possível atualizar o serviço do modo automático: ${e.message}")
        }
    }

    // ─── Atualizar notificação do serviço via Bridge ───────────────────────
    // Chamado pelo android-bridge.js nos eventos canal-aberto / canal-fechado

    @JavascriptInterface
    fun updateServiceStatus(connected: Boolean, deviceName: String) {
        try {
            val intent = Intent(activity, PhysicalCloudService::class.java).apply {
                action = PhysicalCloudService.ACTION_UPDATE_STATUS
                putExtra(PhysicalCloudService.EXTRA_CONNECTED, connected)
                putExtra(PhysicalCloudService.EXTRA_DEVICE_NAME, deviceName)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            Log.d(TAG, "Status do serviço atualizado: connected=$connected, device=$deviceName")
        } catch (e: Exception) {
            Log.w(TAG, "Erro ao atualizar status do serviço: ${e.message}")
        }
    }

    // ── Bloco E: Atualiza notificação de progresso de transferência ────────
    // Parâmetros:
    //   fileName    — nome do arquivo sendo recebido
    //   progress    — 0–100 (porcentagem), ou -1 para indeterminado
    //   done        — true cancela a notificação de progresso

    @JavascriptInterface
    fun updateTransferProgress(fileName: String, progress: Int, done: Boolean, activeCount: Int = if (done) 0 else 1) {
        try {
            val intent = Intent(activity, PhysicalCloudService::class.java).apply {
                action = PhysicalCloudService.ACTION_UPDATE_TRANSFER
                putExtra(PhysicalCloudService.EXTRA_TRANSFER_FILE_NAME, fileName)
                putExtra(PhysicalCloudService.EXTRA_TRANSFER_PROGRESS, progress)
                putExtra(PhysicalCloudService.EXTRA_TRANSFER_DONE, done)
                putExtra(PhysicalCloudService.EXTRA_ACTIVE_TRANSFERS, activeCount.coerceAtLeast(0))
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Erro ao atualizar progresso de transferência: ${e.message}")
        }
    }

    // ─── Leitura de arquivo por URI (para arquivos compartilhados) ──────────
    //
    // FIX 1: guard de tamanho — arquivos > 50 MB não são carregados de vez.
    // Para arquivos grandes, use openReadStream + readStreamChunk + closeReadStream.

    @JavascriptInterface
    fun readFileAsBase64(uriString: String): String {
        return try {
            val uri = Uri.parse(uriString)

            // Limita também pelo total realmente lido: alguns DocumentProviders
            // retornam SIZE nulo/-1 ou um tamanho que não corresponde ao conteúdo.
            val fileSize = getFileSizeFromUri(uri)
            if (fileSize > MAX_DIRECT_READ_BYTES) {
                return resultError(
                    "Arquivo muito grande para leitura direta (${fileSize} bytes). " +
                    "Use openReadStream + readStreamChunk + closeReadStream."
                )
            }

            val input = activity.contentResolver.openInputStream(uri)
                ?: return resultError("Não foi possível ler o arquivo")
            val output = java.io.ByteArrayOutputStream(
                if (fileSize in 1..MAX_DIRECT_READ_BYTES) fileSize.toInt().coerceAtMost(1024 * 1024) else 8192
            )
            val buffer = ByteArray(8192)
            var totalLido = 0L
            input.use { stream ->
                while (true) {
                    val lidos = stream.read(buffer)
                    if (lidos < 0) break
                    if (lidos == 0) continue
                    totalLido += lidos
                    if (totalLido > MAX_DIRECT_READ_BYTES) {
                        return resultError(
                            "Arquivo excede o limite de leitura direta de 50 MB. " +
                            "Use openReadStream + readStreamChunk + closeReadStream."
                        )
                    }
                    output.write(buffer, 0, lidos)
                }
            }
            val bytes = output.toByteArray()
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            val mimeType = activity.contentResolver.getType(uri) ?: "application/octet-stream"
            val fileName = getFileNameFromUri(uri)

            resultSuccess(mapOf(
                "base64" to base64,
                "mimeType" to mimeType,
                "fileName" to fileName,
                "size" to bytes.size
            ))
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao ler arquivo", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── FIX 1: Leitura incremental (stream) ─────────────────────────────
    //
    // openReadStream  — abre o stream e devolve um handle + metadados
    // readStreamChunk — lê o próximo bloco (máx chunkSize bytes) em base64
    // closeReadStream — fecha o stream e libera recursos

    @JavascriptInterface
    fun openReadStream(uriString: String): String {
        return try {
            val uri = Uri.parse(uriString)
            val stream = activity.contentResolver.openInputStream(uri)
                ?: return resultError("Não foi possível abrir stream de leitura")

            val handle = "rs_${System.currentTimeMillis()}_${(Math.random() * 1_000_000).toInt()}"
            openReadStreams[handle] = stream

            val mimeType = activity.contentResolver.getType(uri) ?: "application/octet-stream"
            val fileName = getFileNameFromUri(uri)
            val totalSize = getFileSizeFromUri(uri)

            Log.d(TAG, "openReadStream: $fileName ($totalSize bytes) -> $handle")
            resultSuccess(mapOf(
                "handle"    to handle,
                "mimeType"  to mimeType,
                "fileName"  to fileName,
                "totalSize" to totalSize
            ))
        } catch (e: Exception) {
            Log.e(TAG, "Erro em openReadStream", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    @JavascriptInterface
    fun readStreamChunk(handle: String, chunkSize: Int): String {
        return try {
            val stream = openReadStreams[handle]
                ?: return resultError("Stream não encontrado: $handle")
            if (chunkSize <= 0 || chunkSize > MAX_STREAM_CHUNK_BYTES) {
                return resultError("Tamanho de bloco inválido. O máximo permitido é 1 MiB.")
            }

            val buf = ByteArray(chunkSize)
            val read = stream.read(buf, 0, chunkSize)

            if (read <= 0) {
                // Stream esgotado
                resultSuccess(mapOf("base64" to "", "bytesRead" to 0, "done" to true))
            } else {
                val base64 = Base64.encodeToString(buf.copyOf(read), Base64.NO_WRAP)
                resultSuccess(mapOf("base64" to base64, "bytesRead" to read, "done" to false))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Erro em readStreamChunk", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    @JavascriptInterface
    fun closeReadStream(handle: String): String {
        return try {
            val stream = openReadStreams.remove(handle)
            stream?.close()
            Log.d(TAG, "closeReadStream: $handle")
            resultSuccess(emptyMap())
        } catch (e: Exception) {
            Log.e(TAG, "Erro em closeReadStream", e)
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── Metadados de arquivo por URI ─────────────────────────────────────

    @JavascriptInterface
    fun getFileMetadata(uriString: String): String {
        return try {
            val uri = Uri.parse(uriString)
            val mimeType = activity.contentResolver.getType(uri) ?: "application/octet-stream"
            val fileName = getFileNameFromUri(uri)
            val size = getFileSizeFromUri(uri)

            resultSuccess(mapOf(
                "fileName" to fileName,
                "mimeType" to mimeType,
                "size" to size
            ))
        } catch (e: Exception) {
            resultError(e.message ?: "Erro desconhecido")
        }
    }

    // ─── Vibração haptica ─────────────────────────────────────────────────

    @JavascriptInterface
    fun vibrate(durationMs: Long) {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                    as android.os.VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                activity.getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(
                    android.os.VibrationEffect.createOneShot(
                        durationMs, android.os.VibrationEffect.DEFAULT_AMPLITUDE
                    )
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(durationMs)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Vibração indisponível: ${e.message}")
        }
    }

    // ─── Compartilhar arquivo recebido com outros apps ────────────────────

    @JavascriptInterface
    fun shareFile(uriString: String, mimeType: String) {
        activity.runOnUiThread {
            try {
                val uri = Uri.parse(uriString)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = mimeType.ifEmpty { "*/*" }
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(Intent.createChooser(intent, "Compartilhar"))
            } catch (e: Exception) {
                Log.e(TAG, "Erro ao compartilhar: ${e.message}")
            }
        }
    }

    // ─── Abrir arquivo com app externo ────────────────────────────────────

    @JavascriptInterface
    fun openFile(uriString: String, mimeType: String) {
        activity.runOnUiThread {
            try {
                val uri = Uri.parse(uriString)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, mimeType.ifEmpty { "*/*" })
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                Toast.makeText(
                    activity,
                    "Nenhum app instalado para abrir este arquivo",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    // ─── Funções privadas utilitárias ─────────────────────────────────────

    private fun getFileNameFromUri(uri: Uri): String {
        activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) return cursor.getString(idx)
            }
        }
        return uri.lastPathSegment ?: "arquivo_${System.currentTimeMillis()}"
    }

    private fun getFileSizeFromUri(uri: Uri): Long {
        activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                if (idx >= 0 && !cursor.isNull(idx)) return cursor.getLong(idx)
            }
        }
        return -1L
    }

    private fun sanitizeFileName(name: String): String {
        return name.replace(Regex("[/\\\\:*?\"<>|]"), "_").take(255)
    }

    private fun guessMimeType(fileName: String): String {
        val ext = fileName.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "pdf" -> "application/pdf"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "mp4" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "ogg" -> "audio/ogg"
            "zip" -> "application/zip"
            "rar" -> "application/x-rar-compressed"
            "txt" -> "text/plain"
            "html" -> "text/html"
            "json" -> "application/json"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            else -> "application/octet-stream"
        }
    }

    private fun resultSuccess(data: Map<String, Any>): String {
        val obj = JSONObject().apply {
            put("success", true)
            data.forEach { (k, v) -> put(k, v) }
        }
        return obj.toString()
    }

    private fun resultError(message: String): String {
        return JSONObject().apply {
            put("success", false)
            put("error", message)
        }.toString()
    }
}
