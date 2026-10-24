// Roar's dictation engine (macOS). Protocol, one line each way (src/dictation.h):
//   roar-dictate <modelDir> [--wav <file>]   (--wav: transcribe that file instead of the mic, for tests)
//   stdin:  load | start | stop
//   stdout: progress <0..1> | preparing | ready | listening | transcribing | text <utf8> | error <message>
// The mic opens only on start, so macOS asks for permission on the first dictation.
import AVFoundation
import FluidAudio
import Foundation

func say(_ line: String) {
    FileHandle.standardOutput.write((line.replacingOccurrences(of: "\n", with: " ") + "\n").data(using: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: roar-dictate <modelDir> [--wav <file>]\n".data(using: .utf8)!)
    exit(2)
}
// FluidAudio downloads the repo's folder into the parent of the directory it is given.
let modelDir = URL(fileURLWithPath: args[1], isDirectory: true)
    .appendingPathComponent(AsrModels.defaultCacheDirectory(for: .v3).lastPathComponent, isDirectory: true)
let wav: URL? = args.firstIndex(of: "--wav").flatMap { $0 + 1 < args.count ? URL(fileURLWithPath: args[$0 + 1]) : nil }

final class Engine: @unchecked Sendable {
    private var asr: AsrManager?
    private var loading: Task<AsrManager, Error>?
    private let audio = AVAudioEngine()
    private let lock = NSLock()
    private var samples: [Float] = []
    private var rate: Double = 16_000
    private var recording = false

    func load() async throws -> AsrManager {
        if let asr { return asr }
        if let loading { return try await loading.value }
        let task = Task<AsrManager, Error> {
            let models = try await AsrModels.downloadAndLoad(to: modelDir, version: .v3) { p in
                switch p.phase {
                case .downloading: say("progress \(p.fractionCompleted)")
                case .compiling: say("preparing")
                default: break
                }
            }
            let m = AsrManager()
            try await m.loadModels(models)
            return m
        }
        loading = task
        defer { loading = nil }
        let m = try await task.value
        asr = m
        return m
    }

    func start() {
        guard !recording else { return }
        lock.withLock { samples.removeAll() }
        if wav == nil {
            let input = audio.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { return say("error No microphone found") }
            rate = format.sampleRate
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buf, _ in
                guard let self, let ch = buf.floatChannelData?[0] else { return }
                let chunk = Array(UnsafeBufferPointer(start: ch, count: Int(buf.frameLength)))
                self.lock.withLock { self.samples += chunk }
            }
            do { try audio.start() } catch {
                input.removeTap(onBus: 0)
                return say("error Couldn't open the microphone: \(error.localizedDescription)")
            }
        }
        recording = true
        say("listening")
    }

    func stop() async {
        guard recording else { return }
        recording = false
        if wav == nil { audio.inputNode.removeTap(onBus: 0); audio.stop() }
        let taken = lock.withLock { () -> [Float] in defer { samples.removeAll() }; return samples }
        say("transcribing")
        do {
            let pcm = try wav.map { try AudioConverter().resampleAudioFile($0) } ?? AudioConverter().resample(taken, from: rate)
            // Parakeet needs about a second of audio; shorter takes are almost always accidental.
            guard pcm.count >= 16_000 else { return say("error Didn't catch that. Speak for at least a second.") }
            let m = try await load()
            var state = TdtDecoderState.make()
            let started = Date()
            let text = try await m.transcribe(pcm, decoderState: &state).text
            FileHandle.standardError.write("roar-dictate: \(pcm.count / 16) ms audio in \(Int(Date().timeIntervalSince(started) * 1000)) ms\n".data(using: .utf8)!)
            say("text \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
        } catch {
            say("error \(error.localizedDescription)")
        }
    }
}

let engine = Engine()
Task.detached {
    while let line = readLine() {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "load":
            do { _ = try await engine.load(); say("ready") } catch { say("error \(error.localizedDescription)") }
        case "start": engine.start()
        case "stop": await engine.stop()
        default: break
        }
    }
    exit(0)  // Roar closed the pipe.
}
// Roar gone (quit mid-download or crashed): stop now rather than when the load finishes.
let parent = getppid()
let watch = DispatchSource.makeTimerSource(queue: .global())
watch.schedule(deadline: .now() + 1, repeating: 1)
watch.setEventHandler { if getppid() != parent { exit(0) } }
watch.resume()
dispatchMain()
