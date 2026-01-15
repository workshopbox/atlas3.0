# DAP8 DSP Package Scanner

Web application for scanning packages and verifying DSP assignments based on geographic polygon boundaries.

## Features

### Step 1: Upload Report
- Upload report.csv containing tracking IDs and coordinates
- Automatically parse and load all packages into memory
- Display package count ready for scanning

### Step 2: Package Scanning
- Scan packages by tracking ID
- Automatically match packages to DSPs using coordinate-based polygon detection
- Real-time DSP assignment display
- Track scanned packages count by DSP
- Export scan results to CSV

### Step 3: Sequencing Verification
- Upload Search Result CSV after sequencing
- Compare scanned packages with system assignments
- Identify mismatches between scanned and system DSPs
- View matches, mismatches, and packages not scanned
- Export comparison report

## File Structure

```
dsp-scanner/
├── index.html          # Main HTML file
├── style.css           # Styling
├── scripts.js          # JavaScript logic
├── routes/             # JSON route polygon files
│   ├── AMTP.json
│   ├── ABFB.json
│   ├── BBGH.json
│   ├── NALG.json
│   └── MDTR.json
└── README.md          # This file
```

## Setup Instructions

1. **Place all files in the same directory**
   - index.html
   - style.css
   - scripts.js
   - routes/ folder with all 5 DSP JSON files

2. **Serve the application**
   
   You need to run a local web server because the app loads JSON files via fetch().
   
   **Option A: Using Python (easiest)**
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Python 2
   python -m SimpleHTTPServer 8000
   ```
   
   **Option B: Using Node.js**
   ```bash
   npx http-server -p 8000
   ```
   
   **Option C: Using VS Code**
   - Install "Live Server" extension
   - Right-click index.html → "Open with Live Server"

3. **Open in browser**
   - Navigate to `http://localhost:8000`

## Usage

### Step 1: Upload Report CSV

1. Open the web app
2. Click "Upload Report CSV"
3. Select your report.csv file (contains tracking IDs and coordinates)
4. The app will load all packages into memory
5. You'll see: "✓ Report loaded successfully! X packages ready to scan"

### Step 2: Scan Packages

1. The scanning section will now be visible
2. Enter or scan a tracking ID (e.g., AT2215844289)
3. Press "Scan" or hit Enter
4. The app will:
   - Look up the tracking ID in the uploaded report
   - Get the package coordinates
   - Match it to a DSP route polygon
   - Display the assigned DSP and route
5. Continue scanning all packages
6. View summary of packages by DSP
7. Export scan results if needed

### Step 3: Verification (After Sequencing)

1. After sequencing is complete, obtain the Search Result CSV from your system
2. Click "Upload Search Result CSV"
3. Select your CSV file
4. The app will automatically:
   - Compare scanned packages with system assignments
   - Show statistics (matches, mismatches, not scanned)
   - Display detailed comparison tables
5. Review mismatches to identify discrepancies
6. Export comparison report for documentation

## DSP Route Mapping

- **AMTP**: Routes 1-4 (Sequence Order 0-3)
- **ABFB**: Routes 5-8 (Sequence Order 4-7)
- **BBGH**: Routes 9-11 (Sequence Order 8-10)
- **NALG**: Routes 12-13 (Sequence Order 11-12)
- **MDTR**: Routes 14-17 (Sequence Order 13-16)

## Data Persistence

Scanned packages are automatically saved to browser localStorage. Data persists across browser sessions until you click "Clear All" or clear browser data.

## Updating Route Polygons

To update route boundaries:

1. Export new GeoJSON files from your routing system
2. Replace the corresponding JSON files in the `routes/` folder
3. Refresh the browser

## CSV Format Requirements

### Report CSV (report.csv) should contain these columns:
- Query_Item (Tracking ID)
- Latitude
- Longitude  
- Address_Line_2 or Address_Line_3
- City
- Postal_Code
- State

### Search Result CSV should contain these columns:
- Tracking ID
- DSP Name (can be either shortcuts OR full company names)
- City
- Postal
- Sort Zone

**Accepted DSP Name formats:**

The app accepts both shortcuts and full company names:
- **AMTP** or **AllMunA Transportlogistik GmbH**
- **ABFB** or **Albatros FB Express GmbH**
- **BBGH** or **Baba Trans GmbH**
- **NALG** or **NA Logistik GmbH**
- **MDTR** or **MD Transport GmbH**

The app will automatically convert full names to shortcuts for comparison.

## Troubleshooting

### Routes not loading
- Ensure all 5 JSON files are in the `routes/` folder
- Check browser console for errors (F12)
- Make sure you're running a web server (not opening file:// directly)

### Report not uploading
- Verify the CSV file has the correct columns (Query_Item, Latitude, Longitude)
- Check for proper CSV formatting (comma-separated, quoted strings)
- Look for error messages in the browser console

### Package not found after scanning
- Make sure you uploaded the report.csv file first
- Verify the tracking ID exists in the report
- Check that the tracking ID matches exactly (case-sensitive)

### Polygon matching issues
- Verify JSON polygon coordinates are correct
- Check if coordinates are in [longitude, latitude] format (GeoJSON standard)
- Ensure polygons are closed (first and last points match)

### Comparison not working
- Make sure the Search Result CSV has a "DSP Name" column
- Verify DSP names match exactly: AMTP, ABFB, BBGH, NALG, MDTR (case-insensitive)
- Check that tracking IDs in Search Result CSV match what you scanned

## Support

For issues or questions, contact the DAP8 tech team.

---

**Version**: 1.0  
**Last Updated**: January 2026  
**Station**: DAP8 (Steiermark, Austria)
