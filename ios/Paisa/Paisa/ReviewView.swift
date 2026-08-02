import SwiftUI
import Speech
import AVFoundation

@MainActor
final class SpeechInput: ObservableObject {
    @Published var text = ""
    @Published var listening = false
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-IN"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle() async {
        if listening { stop(); return }
        guard await SFSpeechRecognizer.requestAuthorization() == .authorized else { return }
        do {
            let session = AVAudioSession.sharedInstance(); try session.setCategory(.record, mode: .measurement, options: .duckOthers); try session.setActive(true)
            request = SFSpeechAudioBufferRecognitionRequest(); request?.shouldReportPartialResults = true
            let input = engine.inputNode; let format = input.outputFormat(forBus: 0); input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in self?.request?.append(buffer) }
            engine.prepare(); try engine.start(); listening = true
            task = recognizer?.recognitionTask(with: request!) { [weak self] result, error in Task { @MainActor in if let result { self?.text = result.bestTranscription.formattedString }; if error != nil || result?.isFinal == true { self?.stop() } } }
        } catch { stop() }
    }
    func stop() { if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }; request?.endAudio(); task?.cancel(); request = nil; task = nil; listening = false }
}

struct ReviewView: View {
    @Environment(\.dismiss) private var dismiss
    let transactions: [PaisaTransaction]
    @State private var index = 0
    @StateObject private var speech = SpeechInput()
    private var current: PaisaTransaction? { index < transactions.count ? transactions[index] : nil }

    var body: some View {
        VStack(spacing: 20) {
            if let item = current {
                ProgressView(value: Double(index + 1), total: Double(max(1, transactions.count)))
                Spacer(); Text(PaisaFormat.amount(item.amount)).font(.system(size: 42, weight: .bold)); Text(item.merchant).font(.title2.bold())
                Text("What was this payment for?").foregroundStyle(.secondary)
                Button { Task { await speech.toggle() } } label: { VStack { Image(systemName: speech.listening ? "stop.fill" : "mic.fill").font(.title); Text(speech.listening ? "Stop speaking" : "Tap to speak").font(.headline); if speech.listening { ProgressView().tint(.white) } }.frame(width: 145, height: 145).background(speech.listening ? Color.red : Color.orange, in: Circle()).foregroundStyle(.white) }.buttonStyle(.plain)
                HStack { TextField("Type context", text: $speech.text).textFieldStyle(.roundedBorder); if speech.listening { ProgressView() } }
                Button("Save and return to dashboard") { save(item, status: "explained"); dismiss() }.buttonStyle(.borderedProminent).disabled(speech.text.trimmingCharacters(in: .whitespaces).isEmpty)
                HStack { Button("Known / repeat") { save(item, status: "known"); dismiss() }; Button("Skip") { save(item, status: "deferred"); dismiss() } }.buttonStyle(.bordered)
                Spacer()
            } else { ContentUnavailableView("Review complete", systemImage: "checkmark.circle", description: Text("Your money makes sense.")); Button("Back to dashboard") { dismiss() }.buttonStyle(.borderedProminent) }
        }.padding().navigationTitle("Daily review").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Dashboard") { speech.stop(); dismiss() } } }.onDisappear { speech.stop() }
    }
    private func save(_ item: PaisaTransaction, status: String) { item.note = speech.text; item.reviewStatus = status; speech.stop(); index += 1; speech.text = "" }
}
