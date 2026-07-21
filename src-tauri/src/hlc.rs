use crate::error::{AppError, AppResult};
use chrono::{DateTime, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use std::{fmt, sync::Arc};

const WALL_WIDTH: usize = 13;
const COUNTER_WIDTH: usize = 10;
const DEVICE_WIDTH: usize = 32;
const ENCODED_WIDTH: usize = WALL_WIDTH + 1 + COUNTER_WIDTH + 1 + DEVICE_WIDTH;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc {
    pub wall_ms: i64,
    pub counter: u64,
    pub device_id: String,
}

impl Hlc {
    pub fn parse(value: &str) -> AppResult<Self> {
        if value.len() != ENCODED_WIDTH {
            return Err(AppError::invalid_input("invalid HLC stamp length"));
        }
        let mut pieces = value.split('-');
        let wall = pieces.next().unwrap_or_default();
        let counter = pieces.next().unwrap_or_default();
        let device_id = pieces.next().unwrap_or_default();
        if pieces.next().is_some()
            || wall.len() != WALL_WIDTH
            || counter.len() != COUNTER_WIDTH
            || device_id.len() != DEVICE_WIDTH
            || !device_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || device_id.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return Err(AppError::invalid_input("invalid HLC stamp"));
        }
        let wall_ms = wall
            .parse::<i64>()
            .map_err(|_| AppError::invalid_input("invalid HLC wall time"))?;
        let counter = counter
            .parse::<u64>()
            .map_err(|_| AppError::invalid_input("invalid HLC counter"))?;
        if wall_ms < 0 {
            return Err(AppError::invalid_input("invalid HLC wall time"));
        }
        Ok(Self {
            wall_ms,
            counter,
            device_id: device_id.to_owned(),
        })
    }

    pub fn encode(&self) -> AppResult<String> {
        if self.wall_ms < 0
            || self.wall_ms >= 10_i64.pow(WALL_WIDTH as u32)
            || self.counter >= 10_u64.pow(COUNTER_WIDTH as u32)
            || self.device_id.len() != DEVICE_WIDTH
            || !self.device_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.device_id.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return Err(AppError::invalid_input("HLC component is out of range"));
        }
        Ok(format!(
            "{:0WALL_WIDTH$}-{:0COUNTER_WIDTH$}-{}",
            self.wall_ms, self.counter, self.device_id
        ))
    }
}

impl fmt::Display for Hlc {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{:0WALL_WIDTH$}-{:0COUNTER_WIDTH$}-{}",
            self.wall_ms, self.counter, self.device_id
        )
    }
}

pub trait ClockSource: Send + Sync {
    fn now_millis(&self) -> i64;
    fn local_date(&self) -> NaiveDate;
}

#[derive(Debug, Default)]
pub struct SystemClock;

impl ClockSource for SystemClock {
    fn now_millis(&self) -> i64 {
        Utc::now().timestamp_millis()
    }

    fn local_date(&self) -> NaiveDate {
        Local::now().date_naive()
    }
}

pub fn system_clock() -> Arc<dyn ClockSource> {
    Arc::new(SystemClock)
}

pub fn timestamp(millis: i64) -> AppResult<String> {
    let value: DateTime<Utc> = Utc
        .timestamp_millis_opt(millis)
        .single()
        .ok_or_else(|| AppError::invalid_input("clock produced an invalid timestamp"))?;
    Ok(value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlcState {
    pub wall_ms: i64,
    pub counter: u64,
}

impl HlcState {
    pub fn next(&mut self, now_ms: i64, device_id: &str) -> AppResult<Hlc> {
        if now_ms > self.wall_ms {
            self.wall_ms = now_ms;
            self.counter = 0;
        } else {
            self.counter = self
                .counter
                .checked_add(1)
                .ok_or_else(|| AppError::invalid_input("HLC counter overflow"))?;
        }
        Ok(Hlc {
            wall_ms: self.wall_ms,
            counter: self.counter,
            device_id: device_id.to_owned(),
        })
    }

    pub fn observe(&mut self, remote: &Hlc) {
        if remote.wall_ms > self.wall_ms {
            self.wall_ms = remote.wall_ms;
            self.counter = remote.counter;
        } else if remote.wall_ms == self.wall_ms {
            self.counter = self.counter.max(remote.counter);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Hlc, HlcState};

    const DEVICE_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DEVICE_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn encoded_order_matches_component_order() {
        let first = Hlc {
            wall_ms: 1_720_000_000_000,
            counter: 9,
            device_id: DEVICE_B.into(),
        };
        let second = Hlc {
            wall_ms: 1_720_000_000_001,
            counter: 0,
            device_id: DEVICE_A.into(),
        };

        assert!(first.encode().unwrap() < second.encode().unwrap());
        assert_eq!(Hlc::parse(&first.encode().unwrap()).unwrap(), first);
    }

    #[test]
    fn next_clock_is_greater_than_observed_future_clock() {
        let remote = Hlc {
            wall_ms: 9_000,
            counter: 12,
            device_id: DEVICE_B.into(),
        };
        let mut state = HlcState {
            wall_ms: 1_000,
            counter: 0,
        };

        state.observe(&remote);
        let next = state.next(2_000, DEVICE_A).unwrap();

        assert!(next.encode().unwrap() > remote.encode().unwrap());
    }
}
