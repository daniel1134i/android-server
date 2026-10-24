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
            statusMessage = "Debian 12 (Bookworm) готов к работе"
        }
    }

    fun getDebianDir(): File {
        val ctx = appContext ?: throw IllegalStateException("DebianManager не инициализирован")
        return File(ctx.filesDir, "debian")
    }

    fun isInstalled(): Boolean {
        return try {
            val d = getDebianDir()
            File(d, "bin/bash").exists() || File(d, "usr/bin/bash").exists() || File(d, "bin/sh").exists()
        } catch (_: Exception) {
            false
        }
    }

    fun getProotBinary(): File? {
        val ctx = appContext ?: return null
        val nativeLib = File(ctx.applicationInfo.nativeLibraryDir, "libproot.so")
        if (nativeLib.exists()) {
            try { nativeLib.setExecutable(true, false) } catch (_: Exception) {}
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
            val proot = getProotBinary()
            if (proot != null && proot.exists()) {
                proot.setExecutable(true, false)
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

    fun installDebianAsync(customUrl: String? = null): Boolean {
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
                                if ((mode and 73) != 0 || // 0111 octal (executable)
                                    cleanName.startsWith("bin/") ||
                                    cleanName.startsWith("usr/bin/") ||
                                    cleanName.startsWith("sbin/") ||
                                    cleanName.startsWith("usr/sbin/")
                                ) {
                                    try {
                                        Os.chmod(dest.absolutePath, if (mode != 0) mode else 493) // 0755
                                    } catch (_: Exception) {
                                        dest.setExecutable(true, false)
                                    }
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

            // 1. Создание каталогов для монтирования
            listOf("dev", "proc", "sys", "sdcard", "apps", "tmp", "root").forEach { dirName ->
                val f = File(d, dirName)
                if (!f.exists()) f.mkdirs()
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

            // 4. Настройка /tmp прав
            val tmpDir = File(d, "tmp")
            try { Os.chmod(tmpDir.absolutePath, 511) } catch (_: Exception) {} // 0777

            // 5. Обеспечить исполняемость sh/bash
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
        val appsDir = AppManager.appsDir.absolutePath
        val sdcard = Environment.getExternalStorageDirectory().absolutePath

        // $nativeLibraryDir/libproot.so -0 -r $debianDir -b /dev -b /proc -b /sys -b /storage/emulated/0:/sdcard -b $appsDir:/apps -w /apps /bin/bash -c "<cmd>"
        return listOf(
            proot,
            "-0",
            "-r", debianDir,
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "$sdcard:/sdcard",
            "-b", "$appsDir:/apps",
            "-w", workDir,
            "/bin/bash",
            "-c",
            cmd
        )
    }

    fun applyEnvironment(env: MutableMap<String, String>) {
        val cache = appContext?.cacheDir?.absolutePath ?: "/data/local/tmp"
        env["HOME"] = "/root"
        env["USER"] = "root"
        env["LOGNAME"] = "root"
        env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        env["TERM"] = "xterm-256color"
        env["LANG"] = "C.UTF-8"
        env["TMPDIR"] = "/tmp"
        env["PROOT_TMP_DIR"] = cache
        env["SHELL"] = "/bin/bash"
        env.remove("LD_PRELOAD")
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
