import SwiftUI
import SwiftData

enum PaisaCategories {
    static let defaults = ["Food & dining", "Groceries", "Travel", "Shopping", "Bills", "Health", "Entertainment", "Subscriptions", "Education", "Personal care", "Home", "Gifts", "Insurance", "Investments", "Taxes", "Transfers", "Work"]
    static func suggestions(from transactions: [PaisaTransaction]) -> [String] {
        Array(Set(defaults + transactions.map(\.category).filter { !$0.isEmpty && $0.localizedCaseInsensitiveCompare("Uncategorised") != .orderedSame })).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
    static func savedValue(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Uncategorised" : value.trimmingCharacters(in: .whitespacesAndNewlines) }
}

struct PaisaCategoryField: View {
    @Binding var category: String
    let suggestions: [String]
    var body: some View {
        HStack {
            TextField("Choose or type", text: $category)
            Menu {
                ForEach(suggestions, id: \.self) { value in Button(value) { category = value } }
            } label: { Image(systemName: "chevron.down.circle.fill").foregroundStyle(PaisaTheme.forest).font(.title3) }
            .accessibilityLabel("Show category suggestions")
        }
    }
}

struct TransactionsView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }, sort: \PaisaTransaction.occurredAt, order: .reverse) private var transactions: [PaisaTransaction]
    @State private var search = ""
    @State private var editing: PaisaTransaction?
    @State private var addNew = false
    @State private var dateWindow: PaisaDateWindow = .all
    @State private var customFrom = Calendar.current.date(byAdding: .month, value: -1, to: .now) ?? .now
    @State private var customTo = Date.now
    @State private var selecting = false
    @State private var selectedIDs = Set<UUID>()
    private var filtered: [PaisaTransaction] { transactions.filter { dateWindow.contains($0.occurredAt, customFrom: customFrom, customTo: customTo) && (search.isEmpty || "\($0.merchant) \($0.category) \($0.accountTag) \($0.note)".localizedCaseInsensitiveContains(search)) } }
    var body: some View {
        List {
            Section { PaisaDateWindowPicker(selection: $dateWindow, customFrom: $customFrom, customTo: $customTo) }
            ForEach(filtered) { item in
                HStack(spacing: 8) {
                    if selecting { Image(systemName: selectedIDs.contains(item.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(selectedIDs.contains(item.id) ? PaisaTheme.forest : PaisaTheme.muted) }
                    TransactionRow(item: item)
                    if !selecting {
                        Menu { ForEach(PaisaCategories.suggestions(from: transactions), id: \.self) { value in Button(value) { setCategory(value, for: item) } }; Divider(); Button("Edit or add category…") { editing = item } } label: { Image(systemName: "tag.circle.fill").font(.title3).foregroundStyle(PaisaTheme.forest) }.accessibilityLabel("Quickly categorise \(item.merchant)")
                    }
                }
                    .contentShape(Rectangle()).onTapGesture { if selecting { if selectedIDs.contains(item.id) { selectedIDs.remove(item.id) } else { selectedIDs.insert(item.id) } } else { editing = item } }
                    .listRowBackground(PaisaTheme.surface)
                    .listRowSeparatorTint(PaisaTheme.line)
            }
                .onDelete { offsets in offsets.map { filtered[$0] }.forEach { $0.isDeleted = true; $0.updatedAt = .now }; try? context.save(); Task { await sync.syncIfConnected(context: context) } }
        }
        .scrollContentBackground(.hidden)
        .background(PaisaTheme.canvas)
        .searchable(text: $search, prompt: "Merchant, category, or note")
        .navigationTitle("Transactions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button(selecting ? "Cancel" : "Select") { selecting.toggle(); if !selecting { selectedIDs.removeAll() } } }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if selecting { Button("Delete", role: .destructive) { deleteSelected() }.disabled(selectedIDs.isEmpty) }
                else { Button { addNew = true } label: { Label("Add", systemImage: "plus") } }
            }
        }
        .sheet(item: $editing) { TransactionEditor(item: $0) }
        .sheet(isPresented: $addNew) { TransactionEditor(item: nil) }
    }

    private func setCategory(_ value: String, for item: PaisaTransaction) { item.category = value; item.updatedAt = .now; try? context.save(); Task { await sync.syncIfConnected(context: context) } }
    private func deleteSelected() { transactions.filter { selectedIDs.contains($0.id) }.forEach { $0.isDeleted = true; $0.updatedAt = .now }; try? context.save(); selectedIDs.removeAll(); selecting = false; Task { await sync.syncIfConnected(context: context) } }
}

struct TransactionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var allTransactions: [PaisaTransaction]
    let item: PaisaTransaction?
    @State private var merchant = ""; @State private var amount = 0.0; @State private var date = Date(); @State private var timeVerified = true; @State private var category = "Uncategorised"; @State private var accountTag = ""; @State private var note = ""; @State private var status = "unresolved"
    var body: some View {
        NavigationStack {
            Form {
                Section("Payment") {
                    TextField("Merchant", text: $merchant)
                    TextField("Amount", value: $amount, format: .number).keyboardType(.decimalPad)
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Toggle("Exact time known", isOn: $timeVerified)
                    if timeVerified { DatePicker("Time", selection: $date, displayedComponents: .hourAndMinute) }
                }
                Section("Understanding") { LabeledContent("Category") { PaisaCategoryField(category: $category, suggestions: PaisaCategories.suggestions(from: allTransactions)) }; TextField("Account tag", text: $accountTag, prompt: Text("Savings - ICICI")); Picker("Status", selection: $status) { Text("Needs review").tag("unresolved"); Text("Explained").tag("explained"); Text("Known / repeat").tag("known"); Text("Deferred").tag("deferred") }; TextField("Context or note", text: $note, axis: .vertical) }
            }
            .scrollContentBackground(.hidden).background(PaisaTheme.canvas)
            .navigationTitle(item == nil ? "Add transaction" : "Edit transaction")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(merchant.isEmpty || amount <= 0) } }
        }.onAppear { if let item { merchant = item.merchant; amount = item.amount; date = item.occurredAt; timeVerified = item.timeVerified; category = item.category.localizedCaseInsensitiveCompare("Uncategorised") == .orderedSame ? "" : item.category; accountTag = item.accountTag; note = item.note; status = item.reviewStatus } }
    }
    private func save() { let savedCategory = PaisaCategories.savedValue(category); if let item { item.merchant = merchant; item.amount = amount; item.occurredAt = date; item.timeVerified = timeVerified; item.category = savedCategory; item.accountTag = accountTag; item.note = note; item.reviewStatus = status; item.updatedAt = .now } else { context.insert(PaisaTransaction(merchant: merchant, amount: amount, occurredAt: date, timeVerified: timeVerified, category: savedCategory, note: note, reviewStatus: status, accountTag: accountTag)) }; try? context.save(); Task { await sync.syncIfConnected(context: context) }; dismiss() }
}

struct InsightsView: View {
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var transactions: [PaisaTransaction]
    @State private var dateWindow: PaisaDateWindow = .all
    @State private var customFrom = Calendar.current.date(byAdding: .month, value: -1, to: .now) ?? .now
    @State private var customTo = Date.now
    private var visible: [PaisaTransaction] { transactions.filter { dateWindow.contains($0.occurredAt, customFrom: customFrom, customTo: customTo) } }
    private var total: Double { visible.reduce(0) { $0 + $1.amount } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PaisaEyebrow(text: "Spending snapshot")
                PaisaDateWindowPicker(selection: $dateWindow, customFrom: $customFrom, customTo: $customTo)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Total tracked").font(.subheadline).foregroundStyle(.white.opacity(0.7))
                    Text(PaisaFormat.amount(total)).font(.system(size: 38, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    Text("Across \(visible.count) payments").font(.caption).foregroundStyle(.white.opacity(0.65))
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading).background(PaisaTheme.forest, in: RoundedRectangle(cornerRadius: 24))
                PaisaEyebrow(text: "Where it went").padding(.top, 8)
                ForEach(Dictionary(grouping: visible, by: \.category).sorted { $0.value.reduce(0) { $0 + $1.amount } > $1.value.reduce(0) { $0 + $1.amount } }, id: \.key) { category, items in
                    let amount = items.reduce(0) { $0 + $1.amount }
                    PaisaCard {
                        HStack { Text(category).fontWeight(.bold).foregroundStyle(PaisaTheme.ink); Spacer(); Text(PaisaFormat.amount(amount)).fontWeight(.bold).foregroundStyle(PaisaTheme.ink) }
                        ProgressView(value: total > 0 ? amount / total : 0).tint(PaisaTheme.forest).padding(.top, 8)
                        Text("\(items.count) \(items.count == 1 ? "payment" : "payments")").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 4)
                    }
                }
            }.padding(18)
        }
        .background(PaisaTheme.canvas.ignoresSafeArea())
        .navigationTitle("Insights")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}

struct SettingsView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var notifications: NotificationManager
    private let webURL = URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site")!
    @State private var confirmDelete = false
    @State private var dataMessage = ""

    var body: some View {
        Form {
            Section("Cloud sync") {
                Label(sync.status, systemImage: sync.connected ? "checkmark.icloud" : "icloud.slash")
                if sync.connected {
                    Button("Sync now") { Task { await sync.syncIfConnected(context: context) } }.disabled(sync.isWorking)
                    if sync.isWorking && sync.syncTotal > 0 {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("\(sync.syncCompleted) synced · \(max(0, sync.syncTotal - sync.syncCompleted)) left").font(.caption).foregroundStyle(PaisaTheme.muted)
                                Spacer()
                                Button { sync.stopSync() } label: { Image(systemName: "xmark.circle.fill").font(.title3) }.buttonStyle(.plain).accessibilityLabel("Stop sync")
                            }
                            ProgressView(value: Double(sync.syncCompleted), total: Double(max(1, sync.syncTotal))).tint(PaisaTheme.forest)
                        }
                    }
                    Button("Disconnect this iPhone", role: .destructive) { Task { await sync.disconnect() } }.disabled(sync.isWorking)
                } else {
                    Button("Connect with ChatGPT") { Task { await sync.beginPairing() } }.disabled(sync.isWorking)
                }
                if sync.isWorking && sync.syncTotal == 0 { ProgressView("Checking Paisa Inbox…") }
            }
            Section("Daily review") {
                Label(notifications.statusText, systemImage: notifications.isEnabledForPaisa ? "bell.badge.fill" : "bell.slash")
                if notifications.authorizationStatus == .denied {
                    Button("Open notification settings") { notifications.openSystemSettings() }
                } else if notifications.isEnabledForPaisa {
                    Button("Stop notifications on this iPhone", role: .destructive) {
                        let token = notifications.deviceToken; notifications.stopForPaisa()
                        Task { await sync.unregisterPushToken(token) }
                    }.disabled(notifications.isUpdating)
                } else {
                    Button("Enable daily inbox notifications") {
                        Task {
                            await notifications.requestAuthorization()
                            if let token = notifications.deviceToken { await sync.registerPushToken(token) }
                        }
                    }.disabled(notifications.isUpdating)
                }
                if notifications.isUpdating { ProgressView("Updating notification settings…") }
                Text("Paisa Inbox sends at most one reminder when meaningful payments still need context. Your preferred time and quiet hours come from the web dashboard.")
                    .font(.caption).foregroundStyle(PaisaTheme.muted)
            }
            Section("Data controls") {
                Label("Statements are parsed on device", systemImage: "lock.shield")
                Label("Sync tokens stay in Keychain", systemImage: "key")
                Link("Open web dashboard", destination: webURL)
                Button("Delete all transactions", role: .destructive) { confirmDelete = true }.disabled(!sync.connected || sync.isWorking)
                if !sync.connected { Text("Connect to Paisa Inbox before deleting so the same data is removed from every device.").font(.caption).foregroundStyle(PaisaTheme.muted) }
                if !dataMessage.isEmpty { Text(dataMessage).font(.caption).foregroundStyle(PaisaTheme.muted) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(PaisaTheme.canvas)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .alert("Delete all transactions everywhere?", isPresented: $confirmDelete) {
            Button("Cancel", role: .cancel) { }
            Button("Delete everywhere", role: .destructive) { Task { do { let count = try await sync.deleteCloudTransactions(context: context); dataMessage = "Deleted \(count) transaction\(count == 1 ? "" : "s") everywhere." } catch { dataMessage = error.localizedDescription } } }
        } message: { Text("This permanently removes cloud and local transaction history. Your sign-in and preferences remain.") }
    }
}
