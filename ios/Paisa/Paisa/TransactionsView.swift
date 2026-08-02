import SwiftUI
import SwiftData

struct TransactionsView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \PaisaTransaction.occurredAt, order: .reverse) private var transactions: [PaisaTransaction]
    @State private var search = ""
    @State private var editing: PaisaTransaction?
    @State private var addNew = false
    private var filtered: [PaisaTransaction] { search.isEmpty ? transactions : transactions.filter { "\($0.merchant) \($0.category) \($0.note)".localizedCaseInsensitiveContains(search) } }
    var body: some View {
        List {
            ForEach(filtered) { item in Button { editing = item } label: { TransactionRow(item: item) }.buttonStyle(.plain) }
                .onDelete { offsets in offsets.map { filtered[$0] }.forEach(context.delete) }
        }.searchable(text: $search, prompt: "Merchant, category, or note").navigationTitle("Transactions")
        .toolbar { Button { addNew = true } label: { Label("Add", systemImage: "plus") } }
        .sheet(item: $editing) { TransactionEditor(item: $0) }
        .sheet(isPresented: $addNew) { TransactionEditor(item: nil) }
    }
}

struct TransactionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    let item: PaisaTransaction?
    @State private var merchant = ""; @State private var amount = 0.0; @State private var date = Date(); @State private var category = "Uncategorised"; @State private var note = ""; @State private var status = "unresolved"
    var body: some View {
        NavigationStack { Form { TextField("Merchant", text: $merchant); TextField("Amount", value: $amount, format: .number).keyboardType(.decimalPad); DatePicker("Date", selection: $date); TextField("Category", text: $category); Picker("Status", selection: $status) { Text("Needs review").tag("unresolved"); Text("Explained").tag("explained"); Text("Known / repeat").tag("known"); Text("Deferred").tag("deferred") }; TextField("Context or note", text: $note, axis: .vertical) }.navigationTitle(item == nil ? "Add transaction" : "Edit transaction").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(merchant.isEmpty || amount <= 0) } } }.onAppear { if let item { merchant = item.merchant; amount = item.amount; date = item.occurredAt; category = item.category; note = item.note; status = item.reviewStatus } }
    }
    private func save() { if let item { item.merchant = merchant; item.amount = amount; item.occurredAt = date; item.category = category; item.note = note; item.reviewStatus = status } else { context.insert(PaisaTransaction(merchant: merchant, amount: amount, occurredAt: date, category: category, note: note, reviewStatus: status)) }; dismiss() }
}

struct InsightsView: View {
    @Query private var transactions: [PaisaTransaction]
    var body: some View { ScrollView { VStack(spacing: 16) { SummaryCard(title: "Total tracked", value: PaisaFormat.amount(transactions.reduce(0) { $0 + $1.amount }), icon: "chart.bar"); ForEach(Dictionary(grouping: transactions, by: \.category).sorted { $0.value.reduce(0) { $0 + $1.amount } > $1.value.reduce(0) { $0 + $1.amount } }, id: \.key) { category, items in HStack { Text(category); Spacer(); Text(PaisaFormat.amount(items.reduce(0) { $0 + $1.amount })).bold() }.padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14)) } }.padding() }.navigationTitle("Insights") }
}

struct SettingsView: View { var body: some View { Form { Section("Daily review") { DatePicker("Reminder time", selection: .constant(.now), displayedComponents: .hourAndMinute); Toggle("Sunday cleanup", isOn: .constant(true)) }; Section("Privacy") { Label("Statements are parsed on device", systemImage: "lock.shield"); Link("Open web dashboard", destination: URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site")!) } }.navigationTitle("Settings") } }
