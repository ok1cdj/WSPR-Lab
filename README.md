# WSPR Antenna Lab (v1.4.0)

WSPR Antenna Lab is a high-performance web dashboard designed for radio amateurs to compare the real-world propagation characteristics of two different antenna systems using the global WSPR (Weak Signal Propagation Reporter) network.

## Key Features

- **Delta Analysis:** Calculates the spot-by-spot difference ($\Delta G$) and overall **Average System Advantage** using strictly paired spots.
- **Data Export:** Export your filtered and processed WSPR logs, including calculated values like $\Delta G$, into a CSV file.
- **Polar Radiation Pattern:** 360-degree visualization of signal gain with adjustable beamwidth smoothing.
- **Low-Angle Analysis:** Distance-SNR correlation using linear regression to identify antennas better suited for DX (low-angle) vs. regional (high-angle) propagation.
- **Dynamic Thresholding:** User-definable Local and DX zones for precise propagation analysis.
- **Signal Propagation Map:** Interactive great-circle path visualization of received signals.
- **"Match Mode" Logic:** High-precision analysis focusing only on spots where both antennas were documented by the same receiver (or same transmitter in RX mode) in the same time slot.
- **SNR Normalization:** Automatically adjusts for power differences (`SNR - Power`) for a fair comparison.
- **PWA Support:** Fully optimized for mobile use, including Apple devices.

## How It Works

1. **Callsign A:** Enter your primary station callsign.
2. **Callsign B:** Enter a nearby reference station.
3. **Filter:** Select band and time window (up to 24 hours).
4. **Analyze:** The dashboard fetches data directly from WSPRnet and calculates metrics in real-time.

## Technical Details

- **Frontend:** React + Vite + Tailwind CSS
- **Charts:** Recharts
- **Maps:** React Leaflet
- **Backend:** Express (API Proxy)
- **Analytics:** Vercel Analytics

## Feedback

Feedback and suggestions are welcome!
- **Email:** ondra@ok1cdj.com
- **Support:** [Buy Me a Coffee](https://buymeacoffee.com/ok1cdj)

---
*Created with ❤️ by OK1CDJ*
