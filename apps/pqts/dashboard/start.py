#!/usr/bin/env python3
"""
Start the PQTS Real-time Dashboard

Usage:
    python dashboard/start.py
"""

import subprocess
import sys
from pathlib import Path

def start_dashboard():
    """Start Streamlit dashboard"""
    dashboard_path = Path(__file__).parent / "app.py"
    
    print("🚀 Starting PQTS Dashboard...")
    print(f"Dashboard URL: http://localhost:8501")
    print("\nPress Ctrl+C to stop\n")
    
    try:
        subprocess.run([
            sys.executable, "-m", "streamlit", "run",
            str(dashboard_path),
            "--server.headless", "true",
            "--server.port", "8501",
            "--server.enableCORS", "false"
        ])
    except KeyboardInterrupt:
        print("\n✅ Dashboard stopped")

if __name__ == "__main__":
    start_dashboard()
