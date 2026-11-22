// seogi-speech: on-device transcription with macOS 26's SpeechAnalyzer, for Seogi's main process.
//
//   seogi-speech live <locale>   stdin: mono PCM16 at 16 kHz, from the track's first sample.
//                                stdout: {"ready":true}, then one JSON line per result:
//                                {"final":bool,"text":…,"start":s,"end":s}. A non-final result
//                                replaces the previous one of the same stretch.
//   seogi-speech files <locale>  stdin: one audio file path per line. stdout: one JSON line per
//                                file, {"text":…,"segments":[{"text","start","end"}]}.
//
// Errors are {"error":…} lines. SEOGI_TERMS (a JSON array) biases recognition toward glossary terms.
// The system downloads the language's model on first use.
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

struct Failure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data + Data([0x0A]))
}

func json(_ r: SpeechTranscriber.Result) -> [String: Any] {
  ["final": r.isFinal, "text": String(r.text.characters), "start": r.range.start.seconds, "end": r.range.end.seconds]
}

let arguments = CommandLine.arguments
let terms = (ProcessInfo.processInfo.environment["SEOGI_TERMS"]?.data(using: .utf8))
  .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String] } ?? []

func transcriber(volatile: Bool) async throws -> SpeechTranscriber {
  guard arguments.count > 2,
        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: arguments[2]))
  else { throw Failure("unsupported language \(arguments.count > 2 ? arguments[2] : "")") }
  let t = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                            reportingOptions: volatile ? [.volatileResults] : [], attributeOptions: [.audioTimeRange])
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
    try await request.downloadAndInstall()
  }
  return t
}

func analyzer(for t: SpeechTranscriber) async throws -> SpeechAnalyzer {
  let a = SpeechAnalyzer(modules: [t])
  if !terms.isEmpty {
    let context = AnalysisContext()
    context.contextualStrings[.general] = terms
    try await a.setContext(context)
  }
  return a
}

/** Live: stdin audio in, results out as they change. */
func live() async throws {
  let t = try await transcriber(volatile: true)
  let a = try await analyzer(for: t)
  let input = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t]) else { throw Failure("no audio format") }
  let converter = format == input ? nil : AVAudioConverter(from: input, to: format)
  let (stream, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
  try await a.start(inputSequence: stream)
  let results = Task.detached { for try await r in t.results { emit(json(r)) } }
  emit(["ready": true])

  // 100 ms of audio at a time; an odd byte waits for its pair.
  var pending = Data()
  for try await byte in FileHandle.standardInput.bytes {
    pending.append(byte)
    if pending.count < 3200 { continue }
    feed.yield(AnalyzerInput(buffer: try convert(pending, input, format, converter)))
    pending.removeAll(keepingCapacity: true)
  }
  if pending.count >= 2 { feed.yield(AnalyzerInput(buffer: try convert(pending.prefix(pending.count & ~1), input, format, converter))) }
  feed.finish()
  try await a.finalizeAndFinishThroughEndOfInput()
  try await results.value
}

func convert(_ bytes: Data, _ input: AVAudioFormat, _ output: AVAudioFormat, _ converter: AVAudioConverter?) throws -> AVAudioPCMBuffer {
  let frames = AVAudioFrameCount(bytes.count / 2)
  let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: frames)!
  buffer.frameLength = frames
  bytes.withUnsafeBytes { raw in
    buffer.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: Int(frames))
  }
  guard let converter else { return buffer }
  let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(Double(frames) * output.sampleRate / input.sampleRate) + 64)!
  var given = false
  var error: NSError?
  converter.convert(to: out, error: &error) { _, status in
    if given { status.pointee = .noDataNow; return nil }
    given = true
    status.pointee = .haveData
    return buffer
  }
  if let error { throw error }
  return out
}

/** Files: one path per line in, one transcript per line out. */
func files() async throws {
  while let path = readLine() {
    do {
      let t = try await transcriber(volatile: false)
      let a = try await analyzer(for: t)
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
      let collect = Task.detached { () -> [[String: Any]] in
        var lines: [[String: Any]] = []
        for try await r in t.results where r.isFinal { lines.append(json(r)) }
        return lines
      }
      if let end = try await a.analyzeSequence(from: file) { try await a.finalizeAndFinish(through: end) }
      else { await a.cancelAndFinishNow() }
      let segments = try await collect.value
      let text = segments.compactMap { ($0["text"] as? String)?.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
      emit(["text": text, "segments": segments])
    } catch {
      emit(["error": "\(error)"])
    }
  }
}

do {
  switch arguments.count > 1 ? arguments[1] : "" {
  case "live": try await live()
  case "files": try await files()
  default: throw Failure("usage: seogi-speech live|files <locale>")
  }
} catch {
  emit(["error": "\(error)"])
  exit(1)
}
