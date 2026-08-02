import Foundation
import SwiftData

@Model
final class PaisaTransaction {
    @Attribute(.unique) var id: UUID
    var merchant: String
    var amount: Double
    var occurredAt: Date
    var category: String
    var note: String
    var reviewStatus: String
    var source: String

    init(id: UUID = UUID(), merchant: String, amount: Double, occurredAt: Date = .now, category: String = "Uncategorised", note: String = "", reviewStatus: String = "unresolved", source: String = "manual") {
        self.id = id; self.merchant = merchant; self.amount = amount; self.occurredAt = occurredAt
        self.category = category; self.note = note; self.reviewStatus = reviewStatus; self.source = source
    }
}

enum PaisaFormat {
    static let money: NumberFormatter = {
        let value = NumberFormatter(); value.numberStyle = .currency; value.currencyCode = "INR"; value.maximumFractionDigits = 0; value.locale = Locale(identifier: "en_IN"); return value
    }()
    static func amount(_ value: Double) -> String { money.string(from: NSNumber(value: value)) ?? "₹0" }
}
