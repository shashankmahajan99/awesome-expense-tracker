import Foundation
import SwiftData
import SwiftUI

@Model
final class PaisaTransaction {
    @Attribute(.unique) var id: UUID
    var merchant: String
    var amount: Double
    var occurredAt: Date
    var timeVerified: Bool = false
    var category: String
    var note: String
    var reviewStatus: String
    var source: String
    var accountTag: String = ""
    var updatedAt: Date = Date.now
    var isDeleted: Bool = false

    init(id: UUID = UUID(), merchant: String, amount: Double, occurredAt: Date = .now, timeVerified: Bool = true, category: String = "Uncategorised", note: String = "", reviewStatus: String = "unresolved", source: String = "manual", accountTag: String = "", updatedAt: Date = .now, isDeleted: Bool = false) {
        self.id = id; self.merchant = merchant; self.amount = amount; self.occurredAt = occurredAt
        self.timeVerified = timeVerified; self.category = category; self.note = note; self.reviewStatus = reviewStatus; self.source = source; self.accountTag = accountTag; self.updatedAt = updatedAt; self.isDeleted = isDeleted
    }
}

enum PaisaTheme {
    static let canvas = Color(red: 246 / 255, green: 243 / 255, blue: 236 / 255)
    static let surface = Color(red: 252 / 255, green: 250 / 255, blue: 245 / 255)
    static let forest = Color(red: 23 / 255, green: 61 / 255, blue: 53 / 255)
    static let forestSoft = Color(red: 47 / 255, green: 83 / 255, blue: 74 / 255)
    static let ink = Color(red: 24 / 255, green: 35 / 255, blue: 31 / 255)
    static let muted = Color(red: 103 / 255, green: 110 / 255, blue: 103 / 255)
    static let gold = Color(red: 229 / 255, green: 194 / 255, blue: 111 / 255)
    static let peach = Color(red: 230 / 255, green: 174 / 255, blue: 126 / 255)
    static let line = Color(red: 219 / 255, green: 216 / 255, blue: 207 / 255)
}

struct PaisaCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PaisaTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PaisaTheme.line.opacity(0.8)))
    }
}

struct PaisaEyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .tracking(1.6)
            .foregroundStyle(PaisaTheme.muted)
    }
}

enum PaisaFormat {
    static let money: NumberFormatter = {
        let value = NumberFormatter(); value.numberStyle = .currency; value.currencyCode = "INR"; value.maximumFractionDigits = 0; value.locale = Locale(identifier: "en_IN"); return value
    }()
    static func amount(_ value: Double) -> String { money.string(from: NSNumber(value: value)) ?? "₹0" }
    static func transactionDate(_ date: Date, timeVerified: Bool) -> String { timeVerified ? date.formatted(.dateTime.day().month().year().hour().minute()) : date.formatted(.dateTime.day().month().year()) }
}

enum PaisaDateWindow: String, CaseIterable, Identifiable {
    case all = "All time", seven = "Last 7 days", thirty = "Last 30 days", ninety = "Last 90 days", month = "This month", year = "This year"
    var id: String { rawValue }
    func contains(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> Bool {
        guard self != .all else { return true }
        let start: Date?
        switch self {
        case .seven: start = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now))
        case .thirty: start = calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: now))
        case .ninety: start = calendar.date(byAdding: .day, value: -89, to: calendar.startOfDay(for: now))
        case .month: start = calendar.date(from: calendar.dateComponents([.year, .month], from: now))
        case .year: start = calendar.date(from: calendar.dateComponents([.year], from: now))
        case .all: start = nil
        }
        return start.map { date >= $0 && date <= now } ?? true
    }
}

struct PaisaDateWindowPicker: View {
    @Binding var selection: PaisaDateWindow
    var body: some View { Picker("Date window", selection: $selection) { ForEach(PaisaDateWindow.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.menu) }
}
