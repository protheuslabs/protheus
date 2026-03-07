// SPDX-License-Identifier: Apache-2.0
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CompressionReport {
    pub input_bytes: usize,
    pub encoded_units: usize,
    pub estimated_encoded_bytes: usize,
    pub ratio: f64,
}

pub fn rle_encode(input: &[u8]) -> Vec<(u8, u16)> {
    if input.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<(u8, u16)> = Vec::new();
    let mut cur = input[0];
    let mut count: u16 = 1;
    for b in &input[1..] {
        if *b == cur && count < u16::MAX {
            count += 1;
            continue;
        }
        out.push((cur, count));
        cur = *b;
        count = 1;
    }
    out.push((cur, count));
    out
}

#[allow(dead_code)]
pub fn rle_decode(input: &[(u8, u16)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (byte, count) in input {
        for _ in 0..*count {
            out.push(*byte);
        }
    }
    out
}

pub fn report_for(content: &str) -> CompressionReport {
    let bytes = content.as_bytes();
    let encoded = rle_encode(bytes);
    let estimated = encoded.len() * 3;
    let ratio = if bytes.is_empty() {
        1.0
    } else {
        estimated as f64 / bytes.len() as f64
    };
    CompressionReport {
        input_bytes: bytes.len(),
        encoded_units: encoded.len(),
        estimated_encoded_bytes: estimated,
        ratio,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rle_round_trip() {
        let src = b"aaabbbccccdd";
        let enc = rle_encode(src);
        let dec = rle_decode(&enc);
        assert_eq!(src.to_vec(), dec);
    }
}
