# 解决 Android TV 下 ExoPlayer/expo-av 后台播放卡帧问题 (Build 25 修复)

## 问题现象
在使用 `expo-av` (ExoPlayer 底层实现) 播放视频时，在 Android TV (尤其是 Android 12+，如 Chromecast with Google TV) 设备上，如果用户按下首页或返回键将应用退到后台，随后再次打开应用播放视频，画面会永久冻结在之前的某一帧，但可能仍有声音或提示“播放失败”。

## 根本原因
由于底层 React Native TVOS 与 ExoPlayer (SurfaceView/MediaCodec) 的生命周期解绑不及时，导致 Android 在释放内存或挂起应用时，ExoPlayer 的硬件解码器状态损坏。
加之 Android 12 更改了返回键的默认行为（由摧毁 Activity 变为将其移至后台 `moveTaskToBack`），导致受损的解码器状态和死锁的 JS Bridge 线程永远保留在内存中，直到手动杀掉应用才能恢复。

## 解决过程踩坑记录
1. **JS 层修复无效**：早期尝试在 `_layout.tsx` 监听 `AppState` 或捕捉 `BackHandler` 执行 `unloadAsync()`，但由于 JS 线程随同假死，或者被 Android TV 原生导航栈吃掉事件，代码无法稳定执行。
2. **替换 expo-video 失败**：迁移到最新 SDK 的 `expo-video` 触发了与 TVOS 框架底层的另外冲突，导致直接闪退。
3. **原生生命周期钩子失效**：尝试实现 `LifecycleEventListener` 的 `onHostDestroy`。结果由于 Android 12+ 并不去 Destroy 根 Activity（只是把它丢到后台），钩子从未触发。
4. **自定义 JS Module 被中断**：使用 `NativeModules.AppExit` 供 JS 调用。结果由于 Expo 的某些预构建环境差异，加之 JS Bridge 阻塞，这条链路依然不可靠。

## 终极解决方案 (纯底层的 OS 级拦截)
为了彻底摆脱 JS 层和 Android 返回键挂起策略的影响，我们在最底层的 `MainActivity.kt` 进行了暴力重写，拦截了系统原生的 `invokeDefaultOnBackPressed`：

```kotlin
// android/app/src/main/java/com/oriontv/MainActivity.kt

override fun invokeDefaultOnBackPressed() {
    // 关键修复：当 Android TV 触发默认硬件返回键
    // 不要遵守 Android 12+ 将应用退到后台 (moveTaskToBack) 的逻辑！
    // 直接强杀整个原生进程，清空 Dalvik 虚拟机和 C++ 层的 ExoPlayer/MediaCodec 死锁状态！
    finishAffinity()
    android.os.Process.killProcess(android.os.Process.myPid())
    System.exit(0)
    Runtime.getRuntime().halt(0)
}
```

### 配合脚本
为了让这个修改能够兼容 Expo 的特性，我们在打包时会自动将其覆盖至原生目录。
执行逻辑：在根目录触发连按两次返回键 -> 触发 MainActivity 的退出逻辑 -> 彻底摧毁虚拟机 (`halt(0)`) -> 下次重新进来必定是完美冷启动。
