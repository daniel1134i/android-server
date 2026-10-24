package com.daniel.androidserver

import android.content.Context
import android.os.Environment
import android.system.Os
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.json.JSONObject
import org.tukaani.xz.XZInputStream
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

object DebianManager {
    const val DEFAULT_ROOTFS_URL =
        "https://github.com/termux/proot-distro/releases/download/v4.17.3/debian-bookworm-aarch64-pd-v4.17.3.tar.xz"

    private val standardLinuxRootDirs = setOf(
        "bin", "boot", "dev", "etc", "home", "lib", "lib64",
        "media", "mnt", "opt", "proc", "root", "run", "sbin",
        "srv", "sys", "tmp", "usr", "var"
    )

    private var appContext: Context? = null
    val isInstalling = AtomicBoolean(false)
    val installProgress = AtomicInteger(0)
    @Volatile var currentStage: String = "idle" // idle, downloading, extracting, configuring, ready, error
    @Volatile var statusMessage: String = "Не установлен"
    @Volatile var lastError: String? = null

    fun init(context: Context) {
        appContext = context.applicationContext
        ensureProotExecutable()
        if (isInstalled()) {
            configureRootfs()
            currentStage = "ready"
            statusMessage = "Linux Server (PRoot) готов к работе"
        } else if (hasEmbeddedRootfs()) {
            installDebianAsync()
        }
    }

    fun getDebianDir(): File {
        val ctx = appContext ?: throw IllegalStateException("DebianManager не инициализирован")
        return File(ctx.filesDir, "debian")
    }

    fun isInstalled(): Boolean {
        return try {
            val d = getDebianDir()
            File(d, "bin/sh").exists() || File(d, "bin/busybox").exists() || File(d, "usr/bin/python3").exists()
        } catch (_: Exception) {
            false
        }
    }

    fun getProotBinary(): File? {
        val ctx = appContext ?: return null
        val nativeLib = File(ctx.applicationInfo.nativeLibraryDir, "libproot.so")
        if (nativeLib.exists()) {
            return nativeLib
        }
        val fallback = File(ctx.filesDir, "libproot.so")
        if (fallback.exists()) {
            try { fallback.setExecutable(true, false) } catch (_: Exception) {}
            return fallback
        }
        return null
    }

    private fun ensureProotExecutable() {
        try {
            val fallback = File(appContext?.filesDir, "libproot.so")
            if (fallback.exists()) {
                fallback.setExecutable(true, false)
            }
        } catch (_: Exception) {}
    }

    fun getInstallationStatus(): JSONObject {
        val proot = getProotBinary()
        val installed = isInstalled()
        return JSONObject().apply {
            put("installed", installed)
            put("installing", isInstalling.get())
            put("stage", currentStage)
            put("progress", installProgress.get())
            put("message", statusMessage)
            put("last_error", lastError ?: "")
            put("debian_dir", try { getDebianDir().absolutePath } catch (_: Exception) { "" })
            put("proot_bin", proot?.absolutePath ?: "")
            put("proot_available", proot != null && proot.exists())
        }
    }

    fun hasEmbeddedRootfs(): Boolean {
        val ctx = appContext ?: return false
        return try {
            ctx.assets.open("rootfs/debian-rootfs.tar.xz").use { true }
        } catch (_: Exception) {
            false
        }
    }

    fun installDebianAsync(customUrl: String? = null, force: Boolean = false): Boolean {
        if (!force && customUrl.isNullOrBlank() && isInstalled()) {
            currentStage = "ready"
            statusMessage = "Debian 12 (Bookworm) готов к работе"
            ServerService.addLog("[DEBIAN] Подсистема Debian 12 уже установлена и готова к работе", "DEBIAN")
            return false
        }
        if (!isInstalling.compareAndSet(false, true)) {
            return false
        }
        Thread {
            try {
                installDebianInternal(customUrl)
            } catch (t: Throwable) {
                currentStage = "error"
                lastError = t.message ?: t.javaClass.simpleName
                statusMessage = "Ошибка установки: ${t.message ?: t.javaClass.simpleName}"
                ServerService.addLog("[DEBIAN ОШИБКА] ${t.message ?: t.javaClass.simpleName}", "DEBIAN")
            } finally {
                isInstalling.set(false)
            }
        }.start()
        return true
    }

    private fun installDebianInternal(urlStr: String?) {
        val ctx = appContext ?: throw IllegalStateException("Context отсутствует")
        val debianDir = getDebianDir()

        ServerService.addLog("[DEBIAN] Начало развертывания Debian 12 ARM64...", "DEBIAN")

        // 1. Проверяем наличие встроенного офлайн-образа в assets/rootfs
        val isDefaultOrNull = urlStr.isNullOrBlank() || urlStr == DEFAULT_ROOTFS_URL
        if (hasEmbeddedRootfs() && isDefaultOrNull) {
            ServerService.addLog("[DEBIAN] Обнаружен встроенный образ в assets/rootfs/debian-rootfs.tar.xz. Офлайн-распаковка...", "DEBIAN")
            currentStage = "extracting"
            installProgress.set(10)
            statusMessage = "Распаковка встроенного Debian 12 rootfs (офлайн)..."

            if (!debianDir.exists()) debianDir.mkdirs()

            val assetLength = try {
                val fd = ctx.assets.openFd("rootfs/debian-rootfs.tar.xz")
                val len = fd.length
                fd.close()
                len
            } catch (_: Exception) {
                41L * 1024 * 1024
            }

            ctx.assets.open("rootfs/debian-rootfs.tar.xz").use { inStream ->
                extractTarXzStream(inStream, assetLength, debianDir) { pct ->
                    val overall = 10 + (pct * 85 / 100)
                    installProgress.set(overall)
                    statusMessage = "Распаковка rootfs: $pct% ($overall%)"
                }
            }

            currentStage = "configuring"
            installProgress.set(96)
            statusMessage = "Настройка DNS, путей монтирования и прав..."

            configureRootfs()

            installProgress.set(100)
            currentStage = "ready"
            statusMessage = "Debian 12 (Bookworm) успешно установлен и готов к работе!"
            ServerService.addLog("[DEBIAN] Развертывание завершено! Доступна полная Linux-среда Debian 12.", "DEBIAN")
            return
        }

        // 2. Резервный случай: загрузка по сети
        val targetUrl = urlStr ?: DEFAULT_ROOTFS_URL
        currentStage = "downloading"
        installProgress.set(5)
        statusMessage = "Загрузка Debian 12 rootfs (Bookworm ARM64)..."

        val tempArchive = File(ctx.cacheDir, "debian-rootfs-${System.currentTimeMillis()}.tar.xz")
        if (tempArchive.exists()) tempArchive.delete()

        try {
            downloadWithProgress(targetUrl, tempArchive) { pct ->
                val overall = 5 + (pct * 40 / 100)
                installProgress.set(overall)
                statusMessage = "Загрузка rootfs: $pct% ($overall%)"
            }

            ServerService.addLog("[DEBIAN] Архив успешно загружен (${tempArchive.length() / (1024 * 1024)} МБ). Распаковка...", "DEBIAN")

            currentStage = "extracting"
            installProgress.set(45)
            statusMessage = "Распаковка Debian 12 rootfs..."

            if (!debianDir.exists()) debianDir.mkdirs()

            FileInputStream(tempArchive).use { fis ->
                extractTarXzStream(fis, tempArchive.length(), debianDir) { pct ->
                    val overall = 45 + (pct * 50 / 100)
                    installProgress.set(overall)
                    statusMessage = "Распаковка rootfs: $pct% ($overall%)"
                }
            }

            currentStage = "configuring"
            installProgress.set(96)
            statusMessage = "Настройка DNS, путей монтирования и прав..."

            configureRootfs()

            installProgress.set(100)
            currentStage = "ready"
            statusMessage = "Debian 12 (Bookworm) успешно установлен и готов к работе!"
            ServerService.addLog("[DEBIAN] Развертывание завершено. Доступна полная Linux-среда Debian 12!", "DEBIAN")
        } catch (t: Throwable) {
            throw t
        } finally {
            try {
                if (tempArchive.exists()) tempArchive.delete()
            } catch (_: Exception) {}
        }
    }

    private fun downloadWithProgress(urlStr: String, destFile: File, progressCb: (Int) -> Unit) {
        var currentUrl = urlStr
        var conn: HttpURLConnection? = null
        var totalBytes = -1L

        for (redirect in 0..5) {
            val url = URL(currentUrl)
            conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 30000
                readTimeout = 60000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "AndroidServerNode/1.0 (Linux arm64)")
            }

            val code = conn.responseCode
            if (code == 301 || code == 302 || code == 307 || code == 308) {
                val loc = conn.getHeaderField("Location") ?: throw IOException("Редирект без Location")
                currentUrl = loc
                conn.disconnect()
                continue
            }

            if (code !in 200..299) {
                throw IOException("HTTP ошибка при загрузке rootfs: $code")
            }

            totalBytes = conn.contentLengthLong
            break
        }

        val inStream = conn?.inputStream ?: throw IOException("Не удалось открыть поток загрузки")
        var downloaded = 0L
        val buffer = ByteArray(64 * 1024)

        FileOutputStream(destFile).use { out ->
            inStream.use { input ->
                var read: Int
                var lastReported = -1
                while (input.read(buffer).also { read = it } != -1) {
                    out.write(buffer, 0, read)
                    downloaded += read
                    if (totalBytes > 0) {
                        val pct = ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 100)
                        if (pct != lastReported) {
                            lastReported = pct
                            progressCb(pct)
                        }
                    }
                }
            }
        }
    }

    private fun extractTarXzStream(
        inStream: InputStream,
        totalBytes: Long,
        targetDir: File,
        progressCb: (Int) -> Unit
    ) {
        var processedBytes = 0L

        val countingIn = object : FilterInputStream(inStream) {
            var lastPct = -1
            override fun read(): Int {
                val r = super.read()
                if (r != -1) update(1)
                return r
            }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val r = super.read(b, off, len)
                if (r > 0) update(r.toLong())
                return r
            }
            private fun update(n: Long) {
                processedBytes += n
                if (totalBytes > 0) {
                    val pct = ((processedBytes * 100) / totalBytes).toInt().coerceIn(0, 100)
                    if (pct != lastPct) {
                        lastPct = pct
                        progressCb(pct)
                    }
                }
            }
        }

        BufferedInputStream(countingIn, 64 * 1024).use { bis ->
                XZInputStream(bis).use { xzIn ->
                    TarArchiveInputStream(xzIn).use { tarIn ->
                        val canonicalTarget = targetDir.canonicalPath
                        var rootPrefix: String? = null
                        var isFirstEntry = true
                        var entry: TarArchiveEntry? = tarIn.nextTarEntry

                        while (entry != null) {
                            val rawName = entry.name.removePrefix("./").removePrefix("/")

                            // 1. Определение и отсечение корневого префикса (например, debian-bookworm-aarch64/)
                            if (rootPrefix == null && isFirstEntry) {
                                isFirstEntry = false
                                val firstPart = rawName.substringBefore('/')
                                if (firstPart.isNotEmpty() && firstPart !in standardLinuxRootDirs) {
                                    rootPrefix = "$firstPart/"
                                    if (entry.isDirectory && rawName == firstPart) {
                                        entry = tarIn.nextTarEntry
                                        continue
                                    }
                                }
                            }

                            val cleanName = if (rootPrefix != null && rawName.startsWith(rootPrefix)) {
                                rawName.substring(rootPrefix.length)
                            } else {
                                rawName
                            }

                            if (cleanName.isEmpty() || cleanName == ".") {
                                entry = tarIn.nextTarEntry
                                continue
                            }

                            // 2. Пропуск спец-устройств (char/block devices, fifos)
                            if (entry.isBlockDevice || entry.isCharacterDevice || entry.isFIFO) {
                                entry = tarIn.nextTarEntry
                                continue
                            }

                            val dest = File(targetDir, cleanName)
                            val parentFile = dest.parentFile ?: targetDir

                            // 3. Tar Slip валидация: проверяем канонический путь ТОЛЬКО родительской папки
                            val canonicalParent = parentFile.canonicalPath
                            if (!canonicalParent.startsWith(canonicalTarget + File.separator) && canonicalParent != canonicalTarget) {
                                throw SecurityException("Обнаружена попытка Tar Slip: ${entry.name}")
                            }

                            if (entry.isDirectory) {
                                dest.mkdirs()
                                try { Os.chmod(dest.absolutePath, 493) } catch (_: Exception) {} // 0755
                            } else if (entry.isSymbolicLink) {
                                parentFile.mkdirs()
                                try {
                                    if (dest.exists() || Files.isSymbolicLink(dest.toPath())) {
                                        dest.delete()
                                    }
                                    Os.symlink(entry.linkName, dest.absolutePath)
                                } catch (_: Exception) {}
                            } else if (entry.isLink) {
                                // 4. Жесткие ссылки: отсекаем префиксы
                                parentFile.mkdirs()
                                try {
                                    val linkClean = entry.linkName.removePrefix("./").removePrefix("/")
                                    val linkTargetClean = if (rootPrefix != null && linkClean.startsWith(rootPrefix)) {
                                        linkClean.substring(rootPrefix.length)
                                    } else {
                                        linkClean
                                    }
                                    val src = File(targetDir, linkTargetClean)
                                    if (dest.exists() || Files.isSymbolicLink(dest.toPath())) {
                                        dest.delete()
                                    }
                                    if (src.exists()) {
                                        try {
                                            Os.link(src.absolutePath, dest.absolutePath)
                                        } catch (_: Exception) {
                                            src.copyTo(dest, overwrite = true)
                                        }
                                    }
                                } catch (_: Exception) {}
                            } else {
                                parentFile.mkdirs()
                                FileOutputStream(dest).use { fos ->
                                    tarIn.copyTo(fos)
                                }
                                val mode = entry.mode
                                val isExec = (mode and 73) != 0 || // 0111 octal (executable)
                                    cleanName.startsWith("bin/") ||
                                    cleanName.startsWith("usr/bin/") ||
                                    cleanName.startsWith("sbin/") ||
                                    cleanName.startsWith("usr/sbin/") ||
                                    cleanName.endsWith(".sh")
                                val finalMode = if (isExec) 493 else 420 // 0755 or 0644
                                try {
                                    Os.chmod(dest.absolutePath, finalMode)
                                } catch (_: Exception) {
                                    if (isExec) dest.setExecutable(true, false)
                                }
                            }
                            entry = tarIn.nextTarEntry
                        }
                    }
                }
            }
        }

    fun configureRootfs() {
        try {
            val d = getDebianDir()
            if (!d.exists()) return

            // 1. Создание каталогов для монтирования и установка 0755
            listOf("dev", "proc", "sys", "sdcard", "apps", "root").forEach { dirName ->
                val f = File(d, dirName)
                if (!f.exists()) f.mkdirs()
                try { Os.chmod(f.absolutePath, 493) } catch (_: Exception) {} // 0755
            }

            // Настройка /tmp, /run/postgresql, /run/redis с правами 0777
            listOf("tmp", "run/postgresql", "run/redis").forEach { rel ->
                val dir = File(d, rel).apply { if (!exists()) mkdirs() }
                try { Os.chmod(dir.absolutePath, 511) } catch (_: Exception) {} // 0777
            }

            // Обеспечить права на libshmem.so
            val shmemLib = File(d, "usr/lib/libshmem.so")
            if (shmemLib.exists()) {
                try { Os.chmod(shmemLib.absolutePath, 493) } catch (_: Exception) {}
            }

            // 2. Настройка DNS в resolv.conf
            val etcDir = File(d, "etc").apply { if (!exists()) mkdirs() }
            val resolvConf = File(etcDir, "resolv.conf")
            try {
                if (Files.isSymbolicLink(resolvConf.toPath())) {
                    resolvConf.delete()
                }
            } catch (_: Exception) {}
            resolvConf.writeText(
                """
                nameserver 8.8.8.8
                nameserver 1.1.1.1
                nameserver 2001:4860:4860::8888
                """.trimIndent() + "\n"
            )

            // 3. Настройка hosts
            val hostsFile = File(etcDir, "hosts")
            if (!hostsFile.exists()) {
                hostsFile.writeText(
                    """
                    127.0.0.1 localhost debian
                    ::1 localhost ip6-localhost ip6-loopback
                    """.trimIndent() + "\n"
                )
            }

            // 4. Права 0644 на файлы GPG-ключей (trusted.gpg.d и keyrings)
            listOf("etc/apt/trusted.gpg.d", "usr/share/keyrings").forEach { rel ->
                val kDir = File(d, rel)
                if (kDir.exists()) {
                    try { Os.chmod(kDir.absolutePath, 493) } catch (_: Exception) {} // 0755
                    kDir.walkTopDown().forEach { f ->
                        try {
                            if (f.isDirectory) {
                                Os.chmod(f.absolutePath, 493) // 0755
                            } else {
                                Os.chmod(f.absolutePath, 420) // 0644
                            }
                        } catch (_: Exception) {}
                    }
                }
            }

            // 5. Конфиг apt: 99security
            val aptConfDir = File(d, "etc/apt/apt.conf.d").apply { if (!exists()) mkdirs() }
            File(aptConfDir, "99security").writeText(
                """
                Acquire::AllowInsecureRepositories "true";
                Acquire::AllowDowngradeToInsecureRepositories "true";
                APT::Install-Recommends "0";
                APT::Install-Suggests "0";
                """.trimIndent() + "\n"
            )

            // 6. Обеспечить исполняемость sh/bash (0755)
            listOf("bin/bash", "bin/sh", "usr/bin/bash", "usr/bin/sh").forEach { binRel ->
                val bf = File(d, binRel)
                if (bf.exists()) {
                    try { Os.chmod(bf.absolutePath, 493) } catch (_: Exception) {}
                    bf.setExecutable(true, false)
                }
            }
        } catch (e: Exception) {
            ServerService.addLog("Предупреждение при настройке Debian rootfs: ${e.message}", "DEBIAN")
        }
    }

    fun buildProotCommand(
        cmd: String,
        workDir: String = "/apps"
    ): List<String> {
        val proot = getProotBinary()?.absolutePath ?: throw IllegalStateException("libproot.so не найден в nativeLibraryDir")
        val debianDir = getDebianDir().absolutePath
        val appsDir = AppManager.appsDir.apply { if (!exists()) mkdirs() }.absolutePath
        val cache = appContext?.cacheDir?.absolutePath ?: "/data/local/tmp"
        val files = appContext?.filesDir?.absolutePath ?: "/data/local/tmp"
        val nativeDir = appContext?.applicationInfo?.nativeLibraryDir
        val loader = if (nativeDir != null) File(nativeDir, "libloader.so").absolutePath else ""

        val wrappedGuestCmd = "export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/usr/local/sbin; export HOME=/root; export TMPDIR=/tmp; export LANG=C.UTF-8; $cmd"
        val quotedGuestCmd = "'" + wrappedGuestCmd.replace("'", "'\\''") + "'"

        val hostScript = """
            export HOME='$files'
            export TMPDIR='/tmp'
            export PROOT_TMP_DIR='$cache'
            export PROOT_IGNORE_MISSING_BINDINGS=1
            ${if (loader.isNotEmpty()) "export PROOT_LOADER='$loader'" else ""}
            exec '$proot' --kill-on-exit -0 -l -r '$debianDir' -b /dev -b /proc -b /sys -b '$appsDir:/apps' -w '$workDir' /bin/sh -c $quotedGuestCmd
        """.trimIndent()

        return listOf("/system/bin/sh", "-c", hostScript)
    }

    fun applyEnvironment(env: MutableMap<String, String>) {
        val ctx = appContext
        val cache = ctx?.cacheDir?.absolutePath ?: "/data/local/tmp"
        val files = ctx?.filesDir?.absolutePath ?: "/data/local/tmp"
        val nativeDir = ctx?.applicationInfo?.nativeLibraryDir

        // На хосте процесс u0_a... не имеет доступа к /root, поэтому HOME ставим во внутреннюю память приложения
        env["HOME"] = files
        env["USER"] = "root"
        env["LOGNAME"] = "root"
        // Важно: сохраняем системный PATH хоста Android (/system/bin:/system/xbin:...) для PRoot
        env["PATH"] = "/system/bin:/system/xbin:" + (env["PATH"] ?: "")
        env["TERM"] = "xterm-256color"
        env["LANG"] = "C.UTF-8"
        env["TMPDIR"] = "/tmp"
        env["PROOT_TMP_DIR"] = cache
        env["PROOT_IGNORE_MISSING_BINDINGS"] = "1"
        env["GLIBC_TUNABLES"] = "glibc.pthread.rseq=0"

        if (nativeDir != null) {
            val loader = File(nativeDir, "libloader.so")
            if (loader.exists()) {
                env["PROOT_LOADER"] = loader.absolutePath
            }
        }
        env.remove("LD_PRELOAD")
        env.remove("PROOT_NO_SECCOMP")
    }

    fun uninstall(): Boolean {
        if (isInstalling.get()) return false
        val d = getDebianDir()
        val ok = d.deleteRecursively()
        currentStage = "idle"
        installProgress.set(0)
        statusMessage = "Debian 12 удален"
        ServerService.addLog("Debian 12 rootfs удален", "DEBIAN")
        return ok
    }
}
