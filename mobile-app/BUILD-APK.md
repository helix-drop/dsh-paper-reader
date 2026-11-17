# 打包 Android APK（手机 & 汉王墨水屏通用）

本工程使用 **Capacitor** 将 `mobile-app/www` 与原生插件 [ReaderNativePlugin.java](native-android/ReaderNativePlugin.java) 封装为独立 Android APK，内置：
- 屏蔽安卓系统长按「复制/分享」弹出条（让微信读书式自绘菜单不被遮挡）
- 拦截音量键、PageUp/PageDown 与汉王设备侧边实体翻页键（支持设置页录制按键码）
- 全屏沉浸式阅读栏控制

---

## 方式一：GitHub Actions 自动打包（最省心，无需本地装 Android SDK）

仓库已自带 [.github/workflows/build-android-apk.yml](../.github/workflows/build-android-apk.yml)：

1. 将代码推送到你的 GitHub 仓库 `helix-drop/dsh-paper-reader`；
2. 打开 GitHub 仓库的 **Actions → Build Android APK → Run workflow**；
3. 等待约 2 分钟构建完成后，在工作流页面的 **Artifacts** 中下载 `DSH-Paper-Reader-APK.zip`，解压出 `app-debug.apk` 安装到手机和汉王设备即可。

---

## 方式二：本地手动构建（需已安装 Node.js、JDK 17+ 与 Android SDK）

```bash
cd mobile-app
npm install
npx cap add android
cp native-android/ReaderNativePlugin.java android/app/src/main/java/com/dsh/paperreader/
cp native-android/MainActivity.java android/app/src/main/java/com/dsh/paperreader/
npx cap sync android
cd android
./gradlew assembleDebug
```

生成的 APK 位于 `mobile-app/android/app/build/outputs/apk/debug/app-debug.apk`。

> **提示**：如果你只是临时用 http://IP:4180 连接云服务器（未配 HTTPS），请确保 `android/app/src/main/AndroidManifest.xml` 的 `<application>` 标签上包含 `android:usesCleartextTraffic="true"`（GitHub Actions 脚本已自动添加）。
