package com.physicalcloud

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import com.physicalcloud.databinding.ActivityMainBinding
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader

    // ─── Bridge JavaScript → Android ──────────────────────────────────────
    private lateinit var jsBridge: PhysicalCloudBridge

    // ─── Launcher para seleção de arquivos ────────────────────────────────
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = pendingFileCallback ?: return@registerForActivityResult
        pendingFileCallback = null
        if (result.resultCode == Activity.RESULT_OK) {
            val uris = mutableListOf<Uri>()
            result.data?.let { data ->
                data.clipData?.let { clip ->
                    for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
                } ?: data.data?.let { uris.add(it) }
            }
            cb.onReceiveValue(uris.toTypedArray())
        } else {
            cb.onReceiveValue(null)
        }
    }

    // ─── Launcher para selecionar pasta de destino (SAF) ──────────────────
    private var pendingFolderCallback: ((Uri?) -> Unit)? = null

    // Launcher reutilizado também pelo Bloco 3 (webkitdirectory)
    private val folderPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        val cb = pendingFolderCallback
        pendingFolderCallback = null
        if (uri != null) {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        }
        cb?.invoke(uri)
    }

    // A permissão de notificações só é solicitada quando o usuário ativa
    // conscientemente a Conexão Automática, nunca na abertura do aplicativo.
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        dispatchNotificationPermissionResult(granted)
    }

    // ─── Launcher para a configuração de otimização de bateria ────────────
    // A solicitação só é aberta depois que o usuário tenta ativar o modo automático.
    private val batteryLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        val permitido = isBatteryOptimizationIgnoredNow()
        if (::webView.isInitialized) {
            val resultado = if (permitido) "true" else "false"
            webView.post {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('physicalcloud:battery-exemption-result',{detail:{granted:$resultado}}));",
                    null
                )
            }
        }
    }

    // ─── BLOCO 5: Botão voltar com double-tap para sair ───────────────────
    private var backPressedOnce = false
    private val backHandler = Handler(Looper.getMainLooper())

    // ─── BLOCO 2: Keep-alive handler para o JS da WebView ────────────────
    private val keepAliveHandler = Handler(Looper.getMainLooper())
    private val keepAliveRunnable = object : Runnable {
        override fun run() {
            try {
                webView.evaluateJavascript("console.log('keep-alive')", null)
            } catch (e: Exception) {
                Log.w(TAG, "Keep-alive falhou: ${e.message}")
            }
            keepAliveHandler.postDelayed(this, KEEP_ALIVE_INTERVAL_MS)
        }
    }

    companion object {
        private const val TAG = "PhysicalCloud"
        const val NOTIFICATION_CHANNEL_ID = "physicalcloud_service"
        private const val KEEP_ALIVE_INTERVAL_MS = 30_000L // 30 segundos
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // ─── BLOCO 5: SplashScreen nativa (evita tela branca/preta) ──────
        installSplashScreen()

        super.onCreate(savedInstanceState)

        setupImmersiveMode()

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        webView = binding.webView
        jsBridge = PhysicalCloudBridge(this)

        setupWebView()
        setupBackPress()
        // Não solicitar permissões durante a inicialização. O seletor SAF não
        // exige permissões amplas de armazenamento; notificações são pedidas
        // somente quando o usuário habilita a Conexão Automática.
        if (getSharedPreferences("pc_prefs", MODE_PRIVATE).getBoolean("auto_mode_active", false)) {
            startBackgroundService()
        }
        handleIncomingShare(intent)
    }

    // ─── Modo imersivo ────────────────────────────────────────────────────
    private fun setupImmersiveMode() {
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    // ─── BLOCO 5: Botão voltar — navega ou pergunta se quer sair ─────────
    private fun setupBackPress() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                    return
                }
                // Na raiz: double-tap para sair
                if (backPressedOnce) {
                    backHandler.removeCallbacksAndMessages(null)
                    val autoAtivo = getSharedPreferences("pc_prefs", MODE_PRIVATE)
                        .getBoolean("auto_mode_active", false)
                    if (autoAtivo) {
                        // Mantém a Activity/WebView viva; não encerra o cliente JS
                        // que mantém o WebSocket usado pela arquitetura do app.
                        moveTaskToBack(true)
                    } else {
                        finish()
                    }
                    return
                }
                backPressedOnce = true
                Toast.makeText(
                    this@MainActivity,
                    "Pressione voltar novamente para sair",
                    Toast.LENGTH_SHORT
                ).show()
                // Reseta flag após 2 segundos
                backHandler.postDelayed({ backPressedOnce = false }, 2000)
            }
        })
    }

    // ─── Configuração completa da WebView ─────────────────────────────────
    private fun setupWebView() {
        val settings = webView.settings
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        settings.apply {
            javaScriptEnabled = true // Necessário para a aplicação e sua ponte nativa.
            javaScriptCanOpenWindowsAutomatically = false
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            userAgentString = userAgentString + " PhysicalCloudApp/1.0 AndroidApp"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = true
            }
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }

        webView.addJavascriptInterface(jsBridge, "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            private fun interceptAppAsset(uri: Uri): WebResourceResponse? {
                val response = assetLoader.shouldInterceptRequest(uri) ?: return null
                if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net" ||
                    !uri.path.orEmpty().startsWith("/assets/www/")) return response

                // Impede iframes externos: addJavascriptInterface também pode ser chamado por frames.
                val headers = HashMap(response.responseHeaders ?: emptyMap())
                headers["Content-Security-Policy"] = "default-src 'self'; " +
                    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
                    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
                    "media-src 'self' data: blob:; font-src 'self' data:; " +
                    "connect-src 'self' https://eiafcjslezluvzuvzrya.supabase.co wss://physical-cloud-server.onrender.com; " +
                    "worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; " +
                    "object-src 'none'; base-uri 'self'; form-action 'self'"
                val status = response.statusCode.takeIf { it in 100..599 } ?: 200
                val reason = response.reasonPhrase ?: "OK"
                return WebResourceResponse(response.mimeType, response.encoding, status, reason, headers, response.data)
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                return interceptAppAsset(request.url) ?: super.shouldInterceptRequest(view, request)
            }

            @Suppress("DEPRECATION")
            override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? {
                return interceptAppAsset(Uri.parse(url)) ?: super.shouldInterceptRequest(view, url)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                val uri = Uri.parse(url)
                val trusted = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
                    uri.path.orEmpty().startsWith("/assets/www/")
                if (!trusted) {
                    view.stopLoading()
                    return
                }
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                injectAndroidCapabilities()
                Log.d(TAG, "Página carregada: $url")
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                Log.e(TAG, "Erro WebView: ${error.description} em ${request.url}")
            }

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val uri = request.url
                val caminho = uri.path.orEmpty()
                val origemInterna = uri.scheme == "https" &&
                    uri.host == "appassets.androidplatform.net" &&
                    caminho.startsWith("/assets/www/")
                if (origemInterna) return false

                // Somente links web explícitos podem sair para o navegador externo.
                if (uri.scheme == "https" || uri.scheme == "http") {
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        true
                    } catch (_: Exception) { true }
                }
                // Bloqueia file://, content://, javascript:, intent://, about: e esquemas desconhecidos.
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            // ─── BLOCO 3: File chooser com suporte a webkitdirectory ──────
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback

                // MODE_OPEN_FOLDER só existe em API 37+. Não inferir seleção de
                // diretório a partir de acceptTypes, que representa MIME types.
                // Nos SDKs anteriores, os botões do app chamam o SAF explicitamente
                // via androidPickFolderFiles() no android-bridge.js.
                val isDirectoryPick = Build.VERSION.SDK_INT >= 37 && fileChooserParams.mode == 2

                if (isDirectoryPick) {
                    // Usa SAF para selecionar pasta e retorna os arquivos dentro dela
                    openFolderPicker { folderUri ->
                        if (folderUri == null) {
                            pendingFileCallback = null
                            filePathCallback.onReceiveValue(null)
                            return@openFolderPicker
                        }
                        val cb = pendingFileCallback ?: return@openFolderPicker
                        pendingFileCallback = null

                        // Coleta recursivamente todos os arquivos da árvore SAF.
                        val docFolder = DocumentFile.fromTreeUri(this@MainActivity, folderUri)
                        val uris = mutableListOf<Uri>()
                        fun visitar(pasta: DocumentFile, profundidade: Int) {
                            if (profundidade > 64 || uris.size >= 10000) return
                            pasta.listFiles().sortedBy { it.name ?: "" }.forEach { filho ->
                                when {
                                    filho.isDirectory -> visitar(filho, profundidade + 1)
                                    filho.isFile && uris.size < 10000 -> uris.add(filho.uri)
                                }
                            }
                        }
                        docFolder?.let { visitar(it, 0) }
                        cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
                    }
                    return true
                }

                // Seleção de arquivos comum
                val intent = fileChooserParams.createIntent().apply {
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                val chooser = Intent.createChooser(intent, "Selecionar arquivos")
                filePickerLauncher.launch(chooser)
                return true
            }

            // Permissão para câmera / microfone (WebRTC)
            override fun onPermissionRequest(request: PermissionRequest) {
                val origin = request.origin
                val origemConfiavel = origin.scheme == "https" &&
                    origin.host == "appassets.androidplatform.net" &&
                    (origin.port == -1 || origin.port == 443)
                if (!origemConfiavel || request.resources.isEmpty()) {
                    request.deny()
                    return
                }
                val permitidos = mutableListOf<String>()
                for (resource in request.resources) {
                    when (resource) {
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                            if (hasPermission(Manifest.permission.CAMERA)) permitidos.add(resource)
                        }
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                            if (hasPermission(Manifest.permission.RECORD_AUDIO)) permitidos.add(resource)
                        }
                        // Recursos desconhecidos são sempre negados por padrão.
                        else -> { request.deny(); return }
                    }
                }
                if (permitidos.size == request.resources.size) request.grant(permitidos.toTypedArray())
                else request.deny()
            }

            override fun onReceivedTitle(view: WebView, title: String) {
                super.onReceivedTitle(view, title)
            }

            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d(TAG, "[JS ${msg.sourceId()}:${msg.lineNumber()}] ${msg.message()}")
                return true
            }
        }

        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    // ─── Injeta variáveis/funções extras no JS ────────────────────────────
    private fun injectAndroidCapabilities() {
        val js = """
            (function() {
                window.isAndroidApp = true;
                window.androidVersion = ${Build.VERSION.SDK_INT};
                
                var avisoWeb = document.querySelector('.aviso-web');
                if (avisoWeb) avisoWeb.style.display = 'none';
                
                var btnApp = document.getElementById('btn-abrir-app-futuro');
                if (btnApp) btnApp.style.display = 'none';

                window.androidOpenFolderPicker = function(callbackName) {
                    AndroidBridge.openFolderPicker(callbackName);
                };
                
                window.androidSaveFile = function(base64Data, fileName, mimeType, folderUri) {
                    return AndroidBridge.saveFile(base64Data, fileName, mimeType, folderUri);
                };
                
                window.androidRequestBatteryExemption = function() {
                    AndroidBridge.requestBatteryExemption();
                };

                // Bloco 1: APIs de escrita em stream
                window.androidStartFileWrite = function(fileName, folderUri) {
                    return AndroidBridge.startFileWrite(fileName, folderUri);
                };
                window.androidAppendChunk = function(fileUri, base64Chunk) {
                    return AndroidBridge.appendChunk(fileUri, base64Chunk);
                };
                window.androidFinishFileWrite = function(fileUri) {
                    return AndroidBridge.finishFileWrite(fileUri);
                };

                // Bloco 4: Listagem de diretório
                window.androidListDirectoryFiles = function(folderUri) {
                    return AndroidBridge.listDirectoryFiles(folderUri);
                };

                // Bloco E: Progresso de transferência → notificação nativa
                window.androidUpdateTransferProgress = function(fileName, progress, done, activeCount) {
                    const count = Number.isFinite(Number(activeCount)) ? Math.max(0, Number(activeCount)) : (done ? 0 : 1);
                    AndroidBridge.updateTransferProgress(fileName, progress == null ? -1 : Number(progress), !!done, count);
                };

                window.dispatchEvent(new CustomEvent('android:bridge-ready'));
                console.log('[Android] Bridge injetado com sucesso');
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    // ─── Permissão de notificações no momento de ativar o modo automático ──
    private fun dispatchNotificationPermissionResult(granted: Boolean) {
        if (!::webView.isInitialized) return
        val value = if (granted) "true" else "false"
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('physicalcloud:notification-permission-result',{detail:{granted:$value}}));",
                null
            )
        }
    }

    fun requestNotificationPermissionForAutoMode() {
        runOnUiThread {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
                dispatchNotificationPermissionResult(true)
            } else {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun isBatteryOptimizationIgnoredNow(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(packageName)
    }

    /** Abre a solicitação do Android a partir de uma ação explícita do usuário. */
    fun openBatteryOptimizationRequest() {
        runOnUiThread {
            if (isBatteryOptimizationIgnoredNow()) {
                if (::webView.isInitialized) {
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('physicalcloud:battery-exemption-result',{detail:{granted:true}}));",
                        null
                    )
                }
                return@runOnUiThread
            }

            val requestIntent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            try {
                // Exibe a solicitação específica para este aplicativo.
                batteryLauncher.launch(requestIntent)
            } catch (erroSolicitacao: Exception) {
                Log.w(TAG, "Solicitação direta de isenção indisponível; tentando a lista do Android.", erroSolicitacao)
                val listaIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                try {
                    batteryLauncher.launch(listaIntent)
                } catch (erroLista: Exception) {
                    Log.w(TAG, "Lista de otimização de bateria indisponível; abrindo detalhes do app.", erroLista)
                    val detalhesIntent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    try {
                        batteryLauncher.launch(detalhesIntent)
                    } catch (erroDetalhes: Exception) {
                        Log.e(TAG, "Não foi possível abrir as configurações de bateria do Android.", erroDetalhes)
                        Toast.makeText(
                            this,
                            "Não foi possível abrir as configurações. Acesse Configurações > Aplicativos > Physical Cloud > Bateria.",
                            Toast.LENGTH_LONG
                        ).show()
                        if (::webView.isInitialized) {
                            webView.evaluateJavascript(
                                "window.dispatchEvent(new CustomEvent('physicalcloud:battery-exemption-result',{detail:{granted:false,unavailable:true}}));",
                                null
                            )
                        }
                    }
                }
            }
        }
    }

    // ── Bloco E: Avisa usuários de fabricantes com políticas restritivas ───
    private fun checkRestrictiveManufacturer() {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val restrictive  = listOf("samsung", "xiaomi", "huawei", "oppo", "oneplus", "vivo", "realme")
        if (restrictive.none { manufacturer.contains(it) }) return

        // Só mostra uma vez (guarda flag em SharedPreferences)
        val prefs = getSharedPreferences("pc_prefs", MODE_PRIVATE)
        if (prefs.getBoolean("manufacturer_warned", false)) return
        prefs.edit().putBoolean("manufacturer_warned", true).apply()

        Toast.makeText(
            this,
            "Para manter a conexão em segundo plano, permita a 'Inicialização automática' e " +
            "'Executar em segundo plano' do Physical Cloud nas configurações do sistema.",
            Toast.LENGTH_LONG
        ).show()
    }

    // ─── Inicia serviço em foreground para manter conexão viva ────────────
    private fun startBackgroundService() {
        val intent = Intent(this, PhysicalCloudService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    // ─── Recebe arquivos compartilhados de outros apps ────────────────────
    private fun handleIncomingShare(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            Intent.ACTION_SEND -> {
                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                uri?.let { sendFileToWebView(listOf(it)) }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris: List<Uri> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM) ?: emptyList()
                }
                if (uris.isNotEmpty()) sendFileToWebView(uris)
            }
        }
    }

    private fun sendFileToWebView(uris: List<Uri>) {
        webView.postDelayed({
            val uriArray = JSONArray()
            uris.forEach { uriArray.put(it.toString()) }
            val detail = JSONObject().put("uris", uriArray)
            val js = "window.dispatchEvent(new CustomEvent('android:shared-files', { detail: $detail }));"
            webView.evaluateJavascript(js, null)
        }, 1500)
    }

    // ─── Abre o seletor de pasta nativo (chamado pelo Bridge e Bloco 3) ───
    fun openFolderPicker(callback: (Uri?) -> Unit) {
        pendingFolderCallback = callback
        folderPickerLauncher.launch(null)
    }

    // ─── Utilitário de permissão ───────────────────────────────────────────
    fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    // ─── Lifecycle ────────────────────────────────────────────────────────
    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
        // Reinicia o keep-alive quando volta ao primeiro plano
        keepAliveHandler.removeCallbacks(keepAliveRunnable)
        keepAliveHandler.postDelayed(keepAliveRunnable, KEEP_ALIVE_INTERVAL_MS)
    }

    override fun onPause() {
        // Com conexão automática ativa, não pausamos a WebView: ela contém o
        // cliente WebSocket da arquitetura atual do Physical Cloud. O serviço
        // foreground mantém o processo priorizado enquanto o app fica minimizado.
        val autoAtivo = getSharedPreferences("pc_prefs", MODE_PRIVATE)
            .getBoolean("auto_mode_active", false)
        if (!autoAtivo) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        keepAliveHandler.removeCallbacks(keepAliveRunnable)
        backHandler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIncomingShare(intent)
    }
}
