//! Which version this build is.
//!
//! `env!("CARGO_PKG_VERSION")` inside this crate is *hook-core's* number, not a
//! product's. The crate is shared by both apps and is deliberately never bumped
//! with them, so using it as the app version made every build report the same
//! stale version — and the update check then compared that stale number with the
//! published index and offered an update the Store had already delivered.
//!
//! Each product therefore hands its own version to `builder`, and everything
//! that speaks about "this build" reads it from here: the version in the corner
//! of the window, the update check, the sign-in payload, the reports and the
//! `X-Hook-App-Version` header.

use std::sync::OnceLock;

static PRODUCT_VERSION: OnceLock<&'static str> = OnceLock::new();

/// Recorded once, by `builder`, from the product's own crate version.
pub fn set(value: &'static str) {
    let _ = PRODUCT_VERSION.set(value);
}

/// The running product's version, falling back to this crate's number for unit
/// tests and any code that runs before setup.
pub fn current() -> String {
    PRODUCT_VERSION
        .get()
        .copied()
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_injected_product_version_wins_and_is_final() {
        assert!(!current().is_empty());
        set("0.3.8");
        assert_eq!(current(), "0.3.8");
        // A second product in the same process cannot rename the first.
        set("9.9.9");
        assert_eq!(current(), "0.3.8");
    }
}
