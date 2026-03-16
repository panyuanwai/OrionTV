package com.oriontv

import android.app.Activity
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AppExitModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String {
        return "AppExit"
    }

    @ReactMethod
    fun forceKill() {
        val activity: Activity? = currentActivity
        activity?.finishAffinity()
        
        android.os.Process.killProcess(android.os.Process.myPid())
        System.exit(0)
    }

    override fun onHostResume() {
        // Do nothing
    }

    override fun onHostPause() {
        // Do nothing
    }

    override fun onHostDestroy() {
        // 关键：当 Activity 被销毁时（比如按返回键退出了 App 主界面），强行杀掉整个进程。
        // 因为 React Native 默认保留 JS Context 和底层 C++ 线程，
        // ExoPlayer 的原生资源会残留并损坏，导致下次重新打开时卡死。
        
        // 延迟 300ms 杀进程，让系统有时间完成基本的 Activity 清理
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            android.os.Process.killProcess(android.os.Process.myPid())
            System.exit(0)
        }, 300)
    }
}
