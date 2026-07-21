use crate::error::{AppError, AppResult};
use uuid::Uuid;

pub const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MIDPOINT_INDEX: usize = ALPHABET.len() / 2;

pub fn validate(value: &str) -> AppResult<()> {
    if value.is_empty()
        || !value.is_ascii()
        || value.bytes().any(|byte| !ALPHABET.contains(&byte))
        || value.as_bytes().last() == ALPHABET.first()
    {
        return Err(AppError::invalid_input("invalid fractional order key"));
    }
    Ok(())
}

pub fn between(lower: Option<&str>, upper: Option<&str>) -> AppResult<String> {
    let mut entropy = UuidEntropy::new();
    between_with_picker(lower, upper, &mut |width| entropy.pick(width))
}

fn between_with_picker(
    lower: Option<&str>,
    upper: Option<&str>,
    picker: &mut impl FnMut(usize) -> usize,
) -> AppResult<String> {
    if let Some(value) = lower {
        validate(value)?;
    }
    if let Some(value) = upper {
        validate(value)?;
    }
    if matches!((lower, upper), (Some(left), Some(right)) if left >= right) {
        return Err(AppError::invalid_input(
            "lower order key must sort before upper order key",
        ));
    }

    let key = between_slices(
        lower.unwrap_or_default().as_bytes(),
        upper.map(str::as_bytes),
        picker,
    );
    let key = String::from_utf8(key).expect("order alphabet is ASCII");
    validate(&key)?;
    if lower.is_some_and(|bound| key.as_str() <= bound)
        || upper.is_some_and(|bound| key.as_str() >= bound)
    {
        return Err(AppError::invalid_input(
            "could not create a key between the requested bounds",
        ));
    }
    Ok(key)
}

fn between_slices(
    lower: &[u8],
    upper: Option<&[u8]>,
    picker: &mut impl FnMut(usize) -> usize,
) -> Vec<u8> {
    let mut common = 0;
    while common < lower.len()
        && upper.is_some_and(|value| common < value.len() && lower[common] == value[common])
    {
        common += 1;
    }

    let mut result = lower[..common].to_vec();
    let lower_digit = lower
        .get(common)
        .map(|byte| digit(*byte) as isize)
        .unwrap_or(-1);
    let upper_digit = upper
        .and_then(|value| value.get(common))
        .map(|byte| digit(*byte) as isize)
        .unwrap_or(ALPHABET.len() as isize);

    if upper_digit - lower_digit > 1 {
        let start = (lower_digit + 1) as usize;
        let width = upper_digit as usize - start;
        let chosen = start + picker(width).min(width - 1);
        result.push(ALPHABET[chosen]);
        if chosen == 0 {
            result.push(ALPHABET[MIDPOINT_INDEX]);
        }
        return result;
    }

    if lower_digit == -1 {
        result.push(ALPHABET[0]);
        let upper_suffix = upper.expect("an adjacent minimum upper digit has a suffix");
        result.extend(between_slices(
            &[],
            Some(&upper_suffix[common + 1..]),
            picker,
        ));
        return result;
    }

    result.push(ALPHABET[lower_digit as usize]);
    result.extend(between_slices(&lower[common + 1..], None, picker));
    result
}

struct UuidEntropy {
    bytes: [u8; 16],
    offset: usize,
}

impl UuidEntropy {
    fn new() -> Self {
        Self {
            bytes: *Uuid::new_v4().as_bytes(),
            offset: 0,
        }
    }

    fn pick(&mut self, width: usize) -> usize {
        if self.offset == self.bytes.len() {
            self.bytes = *Uuid::new_v4().as_bytes();
            self.offset = 0;
        }
        let value = self.bytes[self.offset] as usize;
        self.offset += 1;
        value % width
    }
}

fn digit(byte: u8) -> usize {
    ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .expect("validated order key only contains alphabet bytes")
}

#[cfg(test)]
mod tests {
    use super::between_with_picker;

    fn picker(seed: u64) -> impl FnMut(usize) -> usize {
        let mut state = seed;
        move |width| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            (state as usize) % width
        }
    }

    #[test]
    fn generated_keys_stay_strictly_between_bounds() {
        let mut picker = picker(7);
        let cases = [
            (None, None),
            (None, Some("0V")),
            (Some("A"), Some("B")),
            (Some("AV"), Some("B")),
            (Some("AV"), Some("AV1")),
            (Some("z"), None),
        ];

        for (lower, upper) in cases {
            let key = between_with_picker(lower, upper, &mut picker).unwrap();
            assert!(lower.is_none_or(|value| value < key.as_str()));
            assert!(upper.is_none_or(|value| key.as_str() < value));
        }
    }

    #[test]
    fn repeated_insertion_before_same_key_remains_possible() {
        let mut picker = picker(11);
        let upper = between_with_picker(None, None, &mut picker).unwrap();
        let mut previous = upper.clone();

        for _ in 0..500 {
            let next = between_with_picker(None, Some(&previous), &mut picker).unwrap();
            assert!(next < previous);
            previous = next;
        }
    }
}
