/**
 * mic-record — macOS 麦克风录音 CLI 工具
 *
 * 用法：mic-record <输出WAV路径> <录制秒数>
 *
 * 使用 AVAudioRecorder（AVFoundation 框架），在进程内直接访问麦克风，
 * 绕开 launchd 子进程的 TCC 限制。编译后运行一次即可触发系统授权弹窗。
 *
 * 编译：
 *   swiftc scripts/mic-record.swift -o scripts/mic-record -framework AVFoundation
 */

import AVFoundation
import Foundation

// ── 参数解析 ────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("用法: mic-record <output.wav> <duration_seconds>\n", stderr)
    exit(1)
}

let outputPath = args[1]
let duration = Double(args[2]) ?? 10.0

// ── 麦克风权限申请 ──────────────────────────────────────────────────────────

let permSemaphore = DispatchSemaphore(value: 0)
var permissionGranted = false

AVCaptureDevice.requestAccess(for: .audio) { granted in
    permissionGranted = granted
    permSemaphore.signal()
}
permSemaphore.wait()

guard permissionGranted else {
    fputs("错误：麦克风权限被拒绝，请在系统设置 > 隐私 > 麦克风 中授权\n", stderr)
    exit(2)
}

// ── 录音 ────────────────────────────────────────────────────────────────────

let outputURL = URL(fileURLWithPath: outputPath)

// 确保父目录存在
let dir = outputURL.deletingLastPathComponent().path
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]

do {
    let recorder = try AVAudioRecorder(url: outputURL, settings: settings)
    recorder.prepareToRecord()

    guard recorder.record(forDuration: duration) else {
        fputs("错误：无法启动录音\n", stderr)
        exit(3)
    }

    // RunLoop 驱动 AVAudioRecorder 的音频回调
    RunLoop.main.run(until: Date(timeIntervalSinceNow: duration + 0.5))
    recorder.stop()

    fputs("录音完成：\(outputPath)\n", stderr)
} catch {
    fputs("录音失败：\(error.localizedDescription)\n", stderr)
    exit(4)
}
