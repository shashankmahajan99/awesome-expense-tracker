import SwiftUI
import SwiftData
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
        guard await requestSpeechAuthorization() == .authorized else { return }
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

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}

struct ReviewView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var allTransactions: [PaisaTransaction]
    let transactions: [PaisaTransaction]
    @State private var originalCount: Int
    @State private var category = ""
    @State private var isSaving = false
    @State private var showBatch = false
    @State private var batchMessage = ""
    @StateObject private var speech = SpeechInput()
    private var remaining: [PaisaTransaction] { transactions.filter { !$0.isDeleted && $0.reviewStatus == "unresolved" } }
    private var current: PaisaTransaction? { remaining.first }

    init(transactions: [PaisaTransaction]) {
        self.transactions = transactions
        _originalCount = State(initialValue: transactions.count)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
            if let item = current {
                let reviewed = max(0, originalCount - remaining.count)
                HStack { Text("PAYMENT \(reviewed + 1) OF \(max(originalCount, reviewed + remaining.count))").font(.caption2.bold()).tracking(1).foregroundStyle(PaisaTheme.muted); Spacer(); Text("\(remaining.count) left").font(.caption.weight(.semibold)).foregroundStyle(PaisaTheme.forest) }
                ProgressView(value: Double(reviewed + 1), total: Double(max(1, originalCount))).tint(PaisaTheme.forest)
                PaisaCard {
                    Text(PaisaFormat.amount(item.amount)).font(.system(size: 40, weight: .bold, design: .rounded)).foregroundStyle(PaisaTheme.ink)
                    Text(item.merchant).font(.title2.bold()).foregroundStyle(PaisaTheme.ink)
                    Text([item.accountTag, item.occurredAt.formatted(.dateTime.day().month().hour().minute())].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(PaisaTheme.muted)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("What was this payment for?").font(.headline).foregroundStyle(PaisaTheme.ink)
                    HStack { TextField("Type context", text: $speech.text, axis: .vertical).textFieldStyle(.roundedBorder); if speech.listening { ProgressView() } }
                    LabeledContent("Category") { PaisaCategoryField(category: $category, suggestions: PaisaCategories.suggestions(from: allTransactions)) }
                        .padding(12).background(PaisaTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                Button { Task { await speech.toggle() } } label: {
                    HStack { Image(systemName: speech.listening ? "stop.fill" : "mic.fill"); Text(speech.listening ? "Stop speaking" : "Speak instead"); Spacer(); if speech.listening { ProgressView().tint(.white) } }
                        .fontWeight(.semibold).padding(.horizontal, 16).frame(height: 48).background(speech.listening ? Color.red : PaisaTheme.forest, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(.white)
                }.buttonStyle(.plain).disabled(isSaving)
                Button { Task { await save(item, status: "explained") } } label: {
                    HStack { Spacer(); if isSaving { ProgressView().tint(PaisaTheme.forest) } else { Text("Save & review next"); Image(systemName: "arrow.right") }; Spacer() }
                        .frame(height: 50).background(PaisaTheme.gold, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(PaisaTheme.forest).fontWeight(.bold)
                }.buttonStyle(.plain).disabled(isSaving || speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                HStack {
                    Button("Known / repeat") { Task { await save(item, status: "known") } }
                    Button("Skip for now") { Task { await save(item, status: "deferred") } }
                }.buttonStyle(.bordered).disabled(isSaving)
                Button { speech.stop(); showBatch = true } label: { Label("Explain several together", systemImage: "text.badge.checkmark") }.fontWeight(.semibold).padding(.top, 4)
                if !batchMessage.isEmpty { Text(batchMessage).font(.caption).foregroundStyle(PaisaTheme.forest).multilineTextAlignment(.center) }
            } else {
                ContentUnavailableView("Review complete", systemImage: "checkmark.circle.fill", description: Text("Your money makes sense."))
                Button("Back to dashboard") { dismiss() }.buttonStyle(.borderedProminent).tint(PaisaTheme.forest)
            }
            }.padding(18)
        }
        .background(PaisaTheme.canvas.ignoresSafeArea())
        .navigationTitle("Daily review").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Dashboard") { speech.stop(); dismiss() } } }
        .sheet(isPresented: $showBatch) { NavigationStack { MobileBatchReviewView(transactions: remaining) { count in batchMessage = "Explained \(count) payment\(count == 1 ? "" : "s")." } } }
        .onAppear { prepareCurrent() }
        .onChange(of: current?.id) { _, _ in prepareCurrent() }
        .onDisappear { speech.stop() }
    }

    private func prepareCurrent() {
        speech.stop(); speech.text = ""
        category = current?.category.localizedCaseInsensitiveCompare("Uncategorised") == .orderedSame ? "" : (current?.category ?? "")
    }

    private func save(_ item: PaisaTransaction, status: String) async {
        guard !isSaving else { return }; isSaving = true; speech.stop()
        if !speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { item.note = speech.text.trimmingCharacters(in: .whitespacesAndNewlines) }
        item.category = PaisaCategories.savedValue(category); item.reviewStatus = status; item.updatedAt = .now
        try? context.save(); await sync.syncIfConnected(context: context); isSaving = false
    }
}

private struct MobileBatchDecision { let transaction: PaisaTransaction; let category: String? }

private enum MobileBatchMatcher {
    private struct Selector { let minimum: Double?; let maximum: Double?; let exact: Double?; let index: Int; func matches(_ value: Double) -> Bool { if let exact { return abs(value - exact) < 0.01 }; if let minimum, value <= minimum { return false }; if let maximum, value >= maximum { return false }; return true } }
    private static let categories: [String: [String]] = [
        "Food & dining": ["food", "meal", "dinner", "lunch", "breakfast", "restaurant", "cafe", "swiggy", "zomato", "pizza"],
        "Groceries": ["grocery", "groceries", "supermarket", "blinkit", "zepto", "bigbasket", "instamart"],
        "Travel": ["travel", "trip", "cab", "taxi", "uber", "ola", "metro", "train", "flight", "fuel", "petrol", "diesel", "toll", "parking", "indian oil"],
        "Shopping": ["shopping", "clothes", "amazon", "flipkart", "myntra", "ajio"],
        "Bills": ["bill", "bills", "electricity", "water", "gas", "recharge", "broadband", "mobile", "rent", "emi"],
        "Health": ["health", "doctor", "pharmacy", "medicine", "medical", "hospital", "apollo"],
        "Entertainment": ["entertainment", "movie", "cinema", "netflix", "spotify", "hotstar", "gaming"],
        "Work": ["work", "office", "business", "client"],
    ]
    private static let stopWords: Set<String> = ["all", "and", "are", "for", "from", "payment", "payments", "spend", "spending", "that", "the", "these", "this", "today", "transaction", "transactions", "was", "were"]

    static func decisions(text: String, transactions: [PaisaTransaction]) -> [MobileBatchDecision] {
        let value = text.lowercased(); let selectors = amountSelectors(value); let mentions = categoryMentions(value)
        let explicitQueue = ["everything", "every payment", "every transaction", "the rest", "these payments", "these transactions"].contains { value.contains($0) }
        let matchAll = (explicitQueue || (words(value).contains("all") && mentions.isEmpty)) && selectors.isEmpty
        let inputTokens = Set(words(value).filter { $0.count > 2 && !stopWords.contains($0) && Double($0) == nil })
        return transactions.compactMap { transaction in
            let haystack = "\(transaction.merchant) \(transaction.note) \(transaction.category)".lowercased()
            let matchedSelectors = selectors.filter { $0.matches(transaction.amount) }
            let merchantTokens = Set(words(haystack).filter { $0.count > 2 && !stopWords.contains($0) })
            let tokenMatch = !inputTokens.isDisjoint(with: merchantTokens)
            let semantic = mentions.filter { mention in categories[mention.category, default: []].contains { haystack.contains($0) } }
            guard matchAll || !matchedSelectors.isEmpty || tokenMatch || !semantic.isEmpty else { return nil }
            let choices = semantic.isEmpty ? mentions : semantic; let merchantRange = (value as NSString).range(of: transaction.merchant.lowercased()); let anchor = matchedSelectors.first?.index ?? (merchantRange.location == NSNotFound ? 0 : merchantRange.location)
            let category = choices.min { abs($0.index - anchor) < abs($1.index - anchor) }?.category
            return MobileBatchDecision(transaction: transaction, category: category)
        }
    }

    private static func words(_ value: String) -> [String] { value.split { !$0.isLetter && !$0.isNumber }.map(String.init) }
    private static func categoryMentions(_ value: String) -> [(category: String, index: Int)] {
        categories.flatMap { category, phrases in phrases.compactMap { phrase in let range = (value as NSString).range(of: phrase); return range.location == NSNotFound ? nil : (category, range.location) } }
    }
    private static func amountSelectors(_ value: String) -> [Selector] {
        var selectors: [Selector] = []; var covered: [NSRange] = []
        func matches(_ pattern: String) -> [NSTextCheckingResult] { (try? NSRegularExpression(pattern: pattern, options: .caseInsensitive))?.matches(in: value, range: NSRange(value.startIndex..., in: value)) ?? [] }
        func amount(_ match: NSTextCheckingResult, _ group: Int) -> Double? { guard let range = Range(match.range(at: group), in: value) else { return nil }; return Double(value[range].replacingOccurrences(of: ",", with: "")) }
        for match in matches(#"\bbetween\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:and|to|-)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)"#) { if let left = amount(match, 1), let right = amount(match, 2) { selectors.append(Selector(minimum: min(left, right) - 0.01, maximum: max(left, right) + 0.01, exact: nil, index: match.range.location)); covered.append(match.range) } }
        for match in matches(#"\b(?:under|below|less than|up to)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)"#) { if let limit = amount(match, 1) { selectors.append(Selector(minimum: nil, maximum: limit, exact: nil, index: match.range.location)); covered.append(match.range) } }
        for match in matches(#"\b(?:over|above|more than)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)"#) { if let limit = amount(match, 1) { selectors.append(Selector(minimum: limit, maximum: nil, exact: nil, index: match.range.location)); covered.append(match.range) } }
        for match in matches(#"(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\b"#) {
            if covered.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) { continue }
            let number = amount(match, match.range(at: 1).location == NSNotFound ? 2 : 1); if let number, !(1900...2100).contains(number) { selectors.append(Selector(minimum: nil, maximum: nil, exact: number, index: match.range.location)) }
        }
        return selectors
    }
}

private struct MobileBatchReviewView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    let transactions: [PaisaTransaction]
    let onApplied: (Int) -> Void
    @StateObject private var speech = SpeechInput()
    @State private var matching = false
    @State private var result = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Use merchant clues, categories, exact amounts, or ranges.").foregroundStyle(PaisaTheme.muted)
                PaisaCard { Text("“The petrol and toll were travel. ₹450 and ₹720 were groceries.”").font(.subheadline).foregroundStyle(PaisaTheme.ink) }
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $speech.text).frame(minHeight: 140).padding(8).scrollContentBackground(.hidden).background(PaisaTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                    if speech.text.isEmpty { Text("Explain several payments in one sentence…").foregroundStyle(PaisaTheme.muted).padding(16).allowsHitTesting(false) }
                }
                Button { Task { await speech.toggle() } } label: { HStack { Image(systemName: speech.listening ? "stop.fill" : "mic.fill"); Text(speech.listening ? "Stop speaking" : "Speak instead"); Spacer(); if speech.listening { ProgressView() } } }.buttonStyle(.bordered).disabled(matching)
                Button { Task { await apply() } } label: { HStack { Spacer(); if matching { ProgressView().tint(PaisaTheme.forest) } else { Text("Match & explain"); Image(systemName: "sparkles") }; Spacer() }.frame(height: 48).background(PaisaTheme.gold, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(PaisaTheme.forest).fontWeight(.bold) }.buttonStyle(.plain).disabled(matching || speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !result.isEmpty { Text(result).font(.subheadline).foregroundStyle(result.hasPrefix("No") ? Color.orange : PaisaTheme.forest) }
                Text("\(transactions.count) unresolved payment\(transactions.count == 1 ? "" : "s") available to match").font(.caption).foregroundStyle(PaisaTheme.muted)
            }.padding(18)
        }
        .background(PaisaTheme.canvas.ignoresSafeArea()).navigationTitle("Explain together").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { speech.stop(); dismiss() } } }.onDisappear { speech.stop() }
    }

    private func apply() async {
        guard !matching else { return }; matching = true; speech.stop()
        let text = speech.text.trimmingCharacters(in: .whitespacesAndNewlines); let decisions = MobileBatchMatcher.decisions(text: text, transactions: transactions)
        guard !decisions.isEmpty else { result = "No confident matches. Try a category, ₹450, or under ₹1,000."; matching = false; return }
        for decision in decisions { decision.transaction.note = text; if let category = decision.category { decision.transaction.category = category }; decision.transaction.reviewStatus = "explained"; decision.transaction.updatedAt = .now }
        try? context.save(); await sync.syncIfConnected(context: context); onApplied(decisions.count); matching = false; dismiss()
    }
}
