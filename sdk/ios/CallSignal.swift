import CallKit

/// Признак «клиент сейчас на звонке» для iOS. Разрешения не нужны.
/// CXCallObserver видит обычные звонки и звонки приложений, работающих через CallKit;
/// номер и собеседник недоступны — только факт разговора.
///
///     let onCall = CallSignal.isOnCall()   // положить в запрос перевода как sender_on_call
enum CallSignal {
    private static let observer = CXCallObserver()

    static func isOnCall() -> Bool {
        observer.calls.contains { !$0.hasEnded }
    }
}
