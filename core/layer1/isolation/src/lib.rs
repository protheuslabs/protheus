// SPDX-License-Identifier: Apache-2.0
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityHandle {
    pub name: String,
    pub granted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sandbox {
    pub capabilities: Vec<CapabilityHandle>,
}

impl Sandbox {
    pub fn new(capabilities: Vec<CapabilityHandle>) -> Self {
        Self { capabilities }
    }

    pub fn can_execute(&self, capability_name: &str) -> bool {
        self.capabilities
            .iter()
            .any(|cap| cap.granted && cap.name == capability_name)
    }

    pub fn run_stub(&self, capability_name: &str) -> Result<(), &'static str> {
        if self.can_execute(capability_name) {
            Ok(())
        } else {
            Err("capability_denied")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CapabilityHandle, Sandbox};

    #[test]
    fn sandbox_stub_denies_when_capability_missing() {
        let sandbox = Sandbox::new(vec![CapabilityHandle {
            name: "net.read".to_string(),
            granted: true,
        }]);

        assert!(sandbox.run_stub("fs.write").is_err());
        assert!(sandbox.run_stub("net.read").is_ok());
    }
}
