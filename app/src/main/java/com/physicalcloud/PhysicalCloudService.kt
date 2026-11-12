package com.physicalcloud

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Serviço em foreground que mantém o processo vivo enquanto o usuário
 * está com o app minimizado. Essencial para WebSocket de sinalização e
 * conexões WebRTC não serem encerradas pelo sistema.
 *
 * O serviço não implementa outro cliente WebSocket: ele mantém o processo Android
 * priorizado e o WakeLock enquanto a WebView empacotada mantém a sessão P2P.
 * O estado do modo automático é persistido e sincronizado pelo JavaScript via Bridge.
 */
class PhysicalCloudService : Service() {

    companion object {
        private const val TAG = "PCService"
        private const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID = "physicalcloud_connection"
        const val CHANNEL_NAME = "Conexão em segundo plano"

        // ── Bloco E: canal de transferência (separado do canal de status) ──
        const val CHANNEL_TRANSFER_ID   = "physicalcloud_transfer"
        const val CHANNEL_TRANSFER_NAME = "Transferência de arquivos"
        const val NOTIFICATION_TRANSFER_ID = 1002

        const val ACTION_UPDATE_STATUS        = "com.physicalcloud.UPDATE_STATUS"
        const val ACTION_UPDATE_TRANSFER      = "com.physicalcloud.UPDATE_TRANSFER"
        const val ACTION_UPDATE_AUTO_MODE     = "com.physicalcloud.UPDATE_AUTO_MODE"
        const val EXTRA_AUTO_MODE_ACTIVE      = "auto_mode_active"
        const val EXTRA_DEVICE_NAME           = "device_name"
        const val EXTRA_CONNECTED             = "connected"
        const val EXTRA_TRANSFER_FILE_NAME    = "transfer_file_name"
        const val EXTRA_TRANSFER_PROGRESS     = "transfer_progress"   // 0–100
        const val EXTRA_TRANSFER_DONE         = "transfer_done"       // boolean
        const val EXTRA_ACTIVE_TRANSFERS      = "active_transfers"    // int
        private const val WAKELOCK_TIMEOUT_MS = 10 * 60 * 1000L
        private const val WAKELOCK_RENEW_MS = 9 * 60 * 1000L
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var connectedDeviceName: String? = null
    private var isConnected: Boolean = false
    private var isTransferActive: Boolean = false
    private var isAutoModeActive: Boolean = false
    private val wakeLockHandler = Handler(Looper.getMainLooper())
    private val renewWakeLockRunnable = object : Runnable {
        override fun run() {
            if (isAutoModeActive || isConnected || isTransferActive) {
                acquireWakeLockWithTimeout()
                wakeLockHandler.postDelayed(this, WAKELOCK_RENEW_MS)
            } else {
                releaseWakeLock()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        createTransferNotificationChannel()   // Bloco E
        isAutoModeActive = getSharedPreferences("pc_prefs", Context.MODE_PRIVATE)
            .getBoolean("auto_mode_active", false)
        Log.d(TAG, "PhysicalCloudService criado; modo automático ativo=$isAutoModeActive")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Atualiza status exibido na notificação
        when (intent?.action) {
            ACTION_UPDATE_AUTO_MODE -> {
                isAutoModeActive = intent.getBooleanExtra(EXTRA_AUTO_MODE_ACTIVE, false)
                if (!isAutoModeActive && !isConnected && !isTransferActive) {
                    // Sem modo automático, conexão ou transferência, o serviço
                    // não deve permanecer em foreground consumindo recursos.
                    releaseWakeLock()
                    wakeLockHandler.removeCallbacks(renewWakeLockRunnable)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION")
                        stopForeground(true)
                    }
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
                updateNotification()
                atualizarWakeLock()
            }
            ACTION_UPDATE_STATUS -> {
                connectedDeviceName = intent.getStringExtra(EXTRA_DEVICE_NAME)
                isConnected = intent.getBooleanExtra(EXTRA_CONNECTED, false)
                updateNotification()
                atualizarWakeLock()
                if (!isAutoModeActive && !isConnected && !isTransferActive) {
                    stopForegroundCompat()
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
            }

            // ── Bloco E: atualiza notificação de transferência ──────────
            ACTION_UPDATE_TRANSFER -> {
                val fileName = intent.getStringExtra(EXTRA_TRANSFER_FILE_NAME) ?: ""
                val progress = intent.getIntExtra(EXTRA_TRANSFER_PROGRESS, -1)
                val done     = intent.getBooleanExtra(EXTRA_TRANSFER_DONE, false)
                val activeCount = intent.getIntExtra(EXTRA_ACTIVE_TRANSFERS, if (done) 0 else 1).coerceAtLeast(0)
                isTransferActive = activeCount > 0
                updateTransferNotification(fileName, progress, done)
                atualizarWakeLock()
                if (!isAutoModeActive && !isConnected && !isTransferActive) {
                    stopForegroundCompat()
                    stopSelfResult(startId)
                    return START_NOT_STICKY
                }
            }
        }

        // Coloca o serviço em foreground imediatamente. connectedDevice cobre a
        // sessão P2P contínua com outros dispositivos pela rede, sem o limite
        // de seis horas aplicável a dataSync em apps target Android 15+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
        atualizarWakeLock()

        // START_STICKY: o serviço é recriado pelo sistema se for morto
        return START_STICKY
    }

    // A remoção da tarefa não tenta recriar uma Activity/WebView por alarme.
    // START_STICKY mantém o serviço quando o sistema remove apenas a tarefa;
    // se o processo inteiro for encerrado, o Android pode recriar o serviço,
    // mas não existe garantia de restauração automática da WebView.

    private fun stopForegroundCompat() {
        releaseWakeLock()
        wakeLockHandler.removeCallbacks(renewWakeLockRunnable)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        wakeLockHandler.removeCallbacksAndMessages(null)
        releaseWakeLock()
        Log.d(TAG, "PhysicalCloudService destruído")
        super.onDestroy()
    }

    // ─── Atualiza notificação sem chamar startForeground novamente ────────
    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification())
    }

    // ─── Notificação persistente ───────────────────────────────────────────
    private fun buildNotification(): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val contentText = when {
            isConnected && !connectedDeviceName.isNullOrBlank() ->
                "Conectado a: $connectedDeviceName"
            isConnected ->
                "Dispositivo conectado"
            isAutoModeActive ->
                "Conexão automática ativa — aguardando dispositivo"
            else ->
                "Aguardando conexão…"
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Physical Cloud")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSilent(true)
            .build()
    }

    // ─── Canal de notificação de status (Android 8+) ──────────────────────
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Mantém a conexão P2P ativa em segundo plano"
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    // ── Bloco E: Canal de notificação de transferência (com som) ──────────
    private fun createTransferNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_TRANSFER_ID,
                CHANNEL_TRANSFER_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Progresso de transferências de arquivos"
                setShowBadge(true)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    // ── Bloco E: Atualiza notificação de progresso de transferência ───────
    fun updateTransferNotification(fileName: String, progressPercent: Int, done: Boolean) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (done) {
            // Cancela a notificação de progresso ao concluir
            nm.cancel(NOTIFICATION_TRANSFER_ID)
            return
        }

        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 1, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val displayName = if (fileName.length > 30) "…${fileName.takeLast(27)}" else fileName
        val contentText = if (progressPercent >= 0) {
            "Recebendo: $displayName ($progressPercent%)"
        } else {
            "Recebendo: $displayName"
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_TRANSFER_ID)
            .setContentTitle("Physical Cloud — Transferência")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)

        if (progressPercent in 0..100) {
            builder.setProgress(100, progressPercent, false)
        } else {
            builder.setProgress(0, 0, true) // indeterminado
        }

        nm.notify(NOTIFICATION_TRANSFER_ID, builder.build())
    }

    // Mantém a CPU acordada enquanto o modo automático aguarda conexões,
    // durante uma sessão P2P ou transferência. O timeout e a renovação
    // evitam WakeLock órfão caso uma notificação de estado seja perdida.
    private fun atualizarWakeLock() {
        val deveManter = isAutoModeActive || isConnected || isTransferActive
        wakeLockHandler.removeCallbacks(renewWakeLockRunnable)
        if (!deveManter) {
            releaseWakeLock()
            return
        }
        acquireWakeLockWithTimeout()
        wakeLockHandler.postDelayed(renewWakeLockRunnable, WAKELOCK_RENEW_MS)
    }

    private fun acquireWakeLockWithTimeout() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PhysicalCloud::ConnectionWakeLock")
        }
        try {
            if (wakeLock?.isHeld != true) wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
            else {
                // Reaquisição com timeout renova a proteção de segurança.
                wakeLock?.release()
                wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Não foi possível atualizar WakeLock: ${e.message}")
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Erro ao liberar WakeLock: ${e.message}")
        }
        wakeLock = null
    }
}
