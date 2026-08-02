import SwiftUI
import SwiftData

struct DashboardView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \PaisaTransaction.occurredAt, order: .reverse) private var transactions: [PaisaTransaction]
    @State private var showReview = false
    @State private var showImport = false

    private var unresolved: [PaisaTransaction] { transactions.filter { $0.reviewStatus == "unresolved" || $0.reviewStatus == "deferred" } }
    private var total: Double { transactions.filter { Calendar.current.isDate($0.occurredAt, inSameDayAs: .now) }.reduce(0) { $0 + $1.amount } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("DAILY FINANCIAL INBOX").font(.caption2.bold()).foregroundStyle(.secondary)
                Text(unresolved.isEmpty ? "Everything makes sense." : "A few things need your attention.").font(.largeTitle.bold())
                Text("You spent \(PaisaFormat.amount(total)) today. \(unresolved.count) payments still need context.").foregroundStyle(.secondary)
                Button { showReview = true } label: { Label("Review \(unresolved.count) payments", systemImage: "sparkles").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(unresolved.isEmpty)
                HStack {
                    SummaryCard(title: "Today", value: PaisaFormat.amount(total), icon: "indianrupeesign.circle")
                    SummaryCard(title: "Understood", value: transactions.isEmpty ? "100%" : "\(Int(Double(transactions.count - unresolved.count) / Double(transactions.count) * 100))%", icon: "checkmark.circle")
                }
                Text("Needs your input").font(.title2.bold())
                ForEach(unresolved.prefix(6)) { item in
                    Button { showReview = true } label: { TransactionRow(item: item) }.buttonStyle(.plain)
                }
            }.padding()
        }
        .navigationTitle("Paisa")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showImport = true } label: { Label("Import", systemImage: "square.and.arrow.down") } } }
        .sheet(isPresented: $showReview) { NavigationStack { ReviewView(transactions: unresolved) } }
        .sheet(isPresented: $showImport) { StatementImportView() }
        .task { seedIfNeeded() }
    }

    private func seedIfNeeded() {
        guard transactions.isEmpty else { return }
        context.insert(PaisaTransaction(merchant: "Sample coffee", amount: 280, category: "Food & dining", source: "sample"))
    }
}

struct SummaryCard: View {
    let title: String; let value: String; let icon: String
    var body: some View { VStack(alignment: .leading, spacing: 10) { Image(systemName: icon).foregroundStyle(.green); Text(value).font(.title2.bold()); Text(title).font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading).padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) }
}

struct TransactionRow: View {
    let item: PaisaTransaction
    var body: some View { HStack { Text(String(item.merchant.prefix(2)).uppercased()).font(.caption.bold()).frame(width: 42, height: 42).background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 12)); VStack(alignment: .leading) { Text(item.merchant).font(.body.bold()); Text(item.occurredAt, format: .dateTime.day().month().hour().minute()).font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(PaisaFormat.amount(item.amount)).fontWeight(.semibold) }.padding(.vertical, 4) }
}
