/**
 * mic-record — macOS 麦克风录音 CLI 工具（Objective-C 版）
 *
 * 用法：mic-record <输出WAV路径> <录制秒数>
 *
 * 使用 AVAudioRecorder（AVFoundation 框架），在进程内直接访问麦克风，
 * 绕开 launchd 子进程的 TCC 限制。编译后运行一次即可触发系统授权弹窗。
 *
 * 编译：
 *   clang scripts/mic-record.m -o scripts/mic-record \
 *     -framework AVFoundation -framework Foundation
 */

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 3) {
            fprintf(stderr, "用法: mic-record <output.wav> <duration_seconds>\n");
            return 1;
        }

        NSString *outputPath = [NSString stringWithUTF8String:argv[1]];
        double duration = atof(argv[2]);
        if (duration <= 0) duration = 10.0;

        // ── 麦克风权限申请 ──────────────────────────────────────────────────────
        dispatch_semaphore_t permSem = dispatch_semaphore_create(0);
        __block BOOL permGranted = NO;

        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                               completionHandler:^(BOOL granted) {
            permGranted = granted;
            dispatch_semaphore_signal(permSem);
        }];
        dispatch_semaphore_wait(permSem, DISPATCH_TIME_FOREVER);

        if (!permGranted) {
            fprintf(stderr, "错误：麦克风权限被拒绝，请在系统设置 > 隐私 > 麦克风 中授权\n");
            return 2;
        }

        // ── 录音 ────────────────────────────────────────────────────────────────
        NSURL *outputURL = [NSURL fileURLWithPath:outputPath];

        // 确保父目录存在
        NSString *dir = [outputURL.URLByDeletingLastPathComponent path];
        [[NSFileManager defaultManager] createDirectoryAtPath:dir
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:nil];

        NSDictionary *settings = @{
            AVFormatIDKey:         @(kAudioFormatLinearPCM),
            AVSampleRateKey:       @16000.0,
            AVNumberOfChannelsKey: @1,
            AVLinearPCMBitDepthKey: @16,
            AVLinearPCMIsFloatKey: @NO,
            AVLinearPCMIsBigEndianKey: @NO,
        };

        NSError *error = nil;
        AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:outputURL
                                                                settings:settings
                                                                   error:&error];
        if (!recorder || error) {
            fprintf(stderr, "错误：创建 AVAudioRecorder 失败: %s\n",
                    error.localizedDescription.UTF8String ?: "未知错误");
            return 3;
        }

        [recorder prepareToRecord];
        if (![recorder recordForDuration:duration]) {
            fprintf(stderr, "错误：无法启动录音\n");
            return 4;
        }

        // RunLoop 驱动 AVAudioRecorder 的音频回调
        [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:duration + 0.5]];
        [recorder stop];

        fprintf(stderr, "录音完成：%s\n", outputPath.UTF8String);
    }
    return 0;
}
