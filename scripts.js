// ==================== DATA STORAGE ====================
let scannedPackages = [];
let routePolygons = [];
let csvData = [];
let reportData = {}; // Stores all packages from report.csv

// DSP route mapping from JSON files
const DSP_JSON_FILES = {
    'AMTP': 'routes/AMTP.json',
    'ABFB': 'routes/ABFB.json',
    'BBGH': 'routes/BBGH.json',
    'NALG': 'routes/NALG.json',
    'MDTR': 'routes/MDTR.json'
};

// DSP full name to shortcut mapping
const DSP_NAME_MAPPING = {
    'ALLMUNA TRANSPORTLOGISTIK GMBH': 'AMTP',
    'ALLMUNA': 'AMTP',
    'AMTP': 'AMTP',
    
    'ALBATROS FB EXPRESS GMBH': 'ABFB',
    'ALBATROS': 'ABFB',
    'ABFB': 'ABFB',
    
    'BABA TRANS GMBH': 'BBGH',
    'BABA TRANS': 'BBGH',
    'BBGH': 'BBGH',
    
    'NA LOGISTIK GMBH': 'NALG',
    'NA LOGISTIK': 'NALG',
    'NALG': 'NALG',
    
    'MD TRANSPORT GMBH': 'MDTR',
    'MD TRANSPORT': 'MDTR',
    'MDTR': 'MDTR'
};

// Function to normalize DSP names to shortcuts
function normalizeDSPName(dspName) {
    if (!dspName) return null;
    
    const normalized = dspName.trim().toUpperCase();
    return DSP_NAME_MAPPING[normalized] || null;
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    loadRoutePolygons();
    loadScannedPackages();
    initializeEventListeners();
});

// ==================== LOAD ROUTE POLYGONS ====================
async function loadRoutePolygons() {
    try {
        for (const [dspName, filePath] of Object.entries(DSP_JSON_FILES)) {
            const response = await fetch(filePath);
            if (!response.ok) {
                console.error(`Failed to load ${dspName} routes`);
                continue;
            }
            
            const geojson = await response.json();
            
            geojson.features.forEach(feature => {
                const coords = feature.geometry.coordinates[0];
                const sequenceOrder = feature.properties.sequenceOrder;
                const routeName = feature.properties.name;
                const routeNumber = sequenceOrder + 1;
                
                routePolygons.push({
                    dsp: dspName,
                    routeNumber: routeNumber,
                    routeName: routeName,
                    coordinates: coords
                });
            });
        }
        
        console.log(`Loaded ${routePolygons.length} routes from ${Object.keys(DSP_JSON_FILES).length} DSPs`);
    } catch (error) {
        console.error('Error loading route polygons:', error);
        showScanResult('Error loading route data. Please check if JSON files are in the routes/ folder.', 'error');
    }
}

// ==================== POINT IN POLYGON CHECK ====================
function pointInPolygon(point, polygon) {
    const [lon, lat] = point;
    let inside = false;
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        
        if (intersect) inside = !inside;
    }
    
    return inside;
}

// ==================== FIND DSP FOR COORDINATES ====================
function findDSPForCoordinates(latitude, longitude) {
    const point = [longitude, latitude];
    
    for (const route of routePolygons) {
        if (pointInPolygon(point, route.coordinates)) {
            return {
                dsp: route.dsp,
                route: route.routeNumber,
                routeName: route.routeName
            };
        }
    }
    
    return null;
}

// ==================== SCAN PACKAGE ====================
function scanPackage(trackingId) {
    if (!trackingId || trackingId.trim() === '') {
        showScanResult('Please enter a tracking ID', 'error');
        return;
    }
    
    trackingId = trackingId.trim().toUpperCase();
    
    // Check if report is loaded
    if (Object.keys(reportData).length === 0) {
        showScanResult('Please upload the report.csv file first!', 'error');
        return;
    }
    
    // Check if already scanned
    if (scannedPackages.find(p => p.trackingId === trackingId)) {
        showScanResult(`Package ${trackingId} already scanned!`, 'error');
        return;
    }
    
    // Get package info from uploaded report
    const packageInfo = getPackageCoordinates(trackingId);
    
    if (!packageInfo) {
        showScanResult(`Package ${trackingId} not found in uploaded report`, 'error');
        return;
    }
    
    const dspInfo = findDSPForCoordinates(packageInfo.latitude, packageInfo.longitude);
    
    if (!dspInfo) {
        showScanResult(`Package ${trackingId} location outside all route boundaries`, 'error');
        return;
    }
    
    const scannedPackage = {
        trackingId: trackingId,
        dsp: dspInfo.dsp,
        route: dspInfo.route,
        routeName: dspInfo.routeName,
        latitude: packageInfo.latitude,
        longitude: packageInfo.longitude,
        address: packageInfo.address,
        city: packageInfo.city,
        timestamp: new Date().toLocaleString()
    };
    
    scannedPackages.push(scannedPackage);
    saveScannedPackages();
    updateScannedTable();
    
    showScanResult(`✓ ${trackingId} → ${dspInfo.dsp} (Route ${dspInfo.route})`, 'success');
    
    // Clear input and refocus
    document.getElementById('tracking-input').value = '';
    document.getElementById('tracking-input').focus();
}

// ==================== GET PACKAGE COORDINATES FROM REPORT ====================
function getPackageCoordinates(trackingId) {
    // Look up tracking ID in the uploaded report data
    return reportData[trackingId] || null;
}

// ==================== UPDATE SCANNED TABLE ====================
function updateScannedTable() {
    const tbody = document.getElementById('scanned-tbody');
    const count = document.getElementById('scan-count');
    
    tbody.innerHTML = '';
    count.textContent = scannedPackages.length;
    
    // Update DSP summary
    updateDSPSummary();
    
    if (scannedPackages.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No packages scanned yet</td></tr>';
        return;
    }
    
    scannedPackages.forEach((pkg, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${pkg.trackingId}</strong></td>
            <td><span class="dsp-badge dsp-${pkg.dsp.toLowerCase()}">${pkg.dsp}</span></td>
            <td>Route ${pkg.route}</td>
            <td>${pkg.timestamp}</td>
            <td><button class="delete-btn" onclick="deletePackage(${index})">Delete</button></td>
        `;
        tbody.appendChild(row);
    });
}

// ==================== UPDATE DSP SUMMARY ====================
function updateDSPSummary() {
    const summaryDiv = document.getElementById('dsp-summary');
    
    const dspCounts = {};
    scannedPackages.forEach(pkg => {
        dspCounts[pkg.dsp] = (dspCounts[pkg.dsp] || 0) + 1;
    });
    
    summaryDiv.innerHTML = '';
    
    Object.entries(dspCounts).sort((a, b) => b[1] - a[1]).forEach(([dsp, count]) => {
        const badge = document.createElement('div');
        badge.className = `dsp-badge dsp-${dsp.toLowerCase()}`;
        badge.textContent = `${dsp}: ${count} packages`;
        summaryDiv.appendChild(badge);
    });
}

// ==================== DELETE PACKAGE ====================
function deletePackage(index) {
    if (confirm('Are you sure you want to delete this package?')) {
        scannedPackages.splice(index, 1);
        saveScannedPackages();
        updateScannedTable();
    }
}

// ==================== CLEAR ALL ====================
function clearAllPackages() {
    if (confirm('Are you sure you want to clear all scanned packages?')) {
        scannedPackages = [];
        saveScannedPackages();
        updateScannedTable();
        showScanResult('All packages cleared', 'success');
    }
}

// ==================== SHOW SCAN RESULT ====================
function showScanResult(message, type) {
    const resultDiv = document.getElementById('scan-result');
    resultDiv.innerHTML = `<div class="result-box result-${type}">${message}</div>`;
    
    // Auto-clear after 3 seconds
    setTimeout(() => {
        resultDiv.innerHTML = '';
    }, 3000);
}

// ==================== LOCAL STORAGE ====================
function saveScannedPackages() {
    localStorage.setItem('scannedPackages', JSON.stringify(scannedPackages));
}

function loadScannedPackages() {
    const saved = localStorage.getItem('scannedPackages');
    if (saved) {
        scannedPackages = JSON.parse(saved);
        updateScannedTable();
    }
}

// ==================== REPORT UPLOAD & PARSING ====================
function handleReportUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('report-file-name').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        parseReport(text);
    };
    reader.readAsText(file);
}

function parseReport(text) {
    const lines = text.split('\n');
    const headers = parseCSVLine(lines[0]);
    
    reportData = {};
    let packageCount = 0;
    
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        
        const values = parseCSVLine(lines[i]);
        const row = {};
        
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        
        const trackingId = row['Query_Item'];
        const latitude = parseFloat(row['Latitude']);
        const longitude = parseFloat(row['Longitude']);
        
        if (trackingId && !isNaN(latitude) && !isNaN(longitude)) {
            reportData[trackingId] = {
                latitude: latitude,
                longitude: longitude,
                address: row['Address_Line_2'] || row['Address_Line_3'] || '',
                city: row['City'] || '',
                postal: row['Postal_Code'] || '',
                state: row['State'] || ''
            };
            packageCount++;
        }
    }
    
    showReportStatus(`✓ Report loaded successfully! ${packageCount} packages ready to scan.`, 'success');
    
    // Show scanning section
    document.getElementById('scanning-section').style.display = 'block';
    document.getElementById('tracking-input').focus();
}

function showReportStatus(message, type) {
    const statusDiv = document.getElementById('report-status');
    statusDiv.innerHTML = `<div class="status-box status-${type}">${message}</div>`;
}

// ==================== CSV UPLOAD & COMPARISON ====================
function handleCSVUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('file-name').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        parseCSV(text);
    };
    reader.readAsText(file);
}

function parseCSV(text) {
    const lines = text.split('\n');
    const headers = parseCSVLine(lines[0]);
    
    csvData = [];
    
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        
        const values = parseCSVLine(lines[i]);
        const row = {};
        
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        
        csvData.push(row);
    }
    
    compareWithScannedPackages();
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current.trim());
    return result;
}

// ==================== COMPARE PACKAGES ====================
function compareWithScannedPackages() {
    const matches = [];
    const mismatches = [];
    const notScanned = [];
    
    csvData.forEach(csvRow => {
        const trackingId = csvRow['Tracking ID'];
        const rawSystemDSP = csvRow['DSP Name'];
        const systemDSP = normalizeDSPName(rawSystemDSP);
        const city = csvRow['City'];
        const postal = csvRow['Postal'];
        const sortZone = csvRow['Sort Zone'];
        
        // Skip if no DSP name in system
        if (!systemDSP) {
            console.warn(`No DSP Name or unrecognized DSP for ${trackingId}: "${rawSystemDSP}"`);
        }
        
        const scannedPkg = scannedPackages.find(p => p.trackingId === trackingId);
        
        if (!scannedPkg) {
            notScanned.push({
                trackingId,
                systemDSP: systemDSP || 'NOT ASSIGNED',
                city,
                postal,
                sortZone
            });
        } else if (scannedPkg.dsp === systemDSP) {
            matches.push({
                trackingId,
                dsp: scannedPkg.dsp,
                route: scannedPkg.route,
                city,
                sortZone
            });
        } else {
            mismatches.push({
                trackingId,
                scannedDSP: scannedPkg.dsp,
                systemDSP: systemDSP || 'NOT ASSIGNED',
                city,
                postal,
                sortZone
            });
        }
    });
    
    displayComparisonResults(matches, mismatches, notScanned);
}

// ==================== EXTRACT DSP FROM SORT ZONE (NOT USED ANYMORE) ====================
// This function is kept for reference but not used in comparison
function extractDSPFromSortZone(sortZone) {
    // Not needed - DSP Name comes from Search Result CSV column
    return 'UNKNOWN';
}

// ==================== DISPLAY COMPARISON RESULTS ====================
function displayComparisonResults(matches, mismatches, notScanned) {
    document.getElementById('comparison-section').style.display = 'block';
    
    // Update stats
    document.getElementById('total-compared').textContent = csvData.length;
    document.getElementById('matches-count').textContent = matches.length;
    document.getElementById('mismatches-count').textContent = mismatches.length;
    document.getElementById('not-scanned-count').textContent = notScanned.length;
    
    // Populate tables
    populateMismatchesTable(mismatches);
    populateMatchesTable(matches);
    populateNotScannedTable(notScanned);
    
    // Scroll to results
    document.getElementById('comparison-section').scrollIntoView({ behavior: 'smooth' });
}

// ==================== POPULATE TABLES ====================
function populateMismatchesTable(mismatches) {
    const tbody = document.getElementById('mismatches-tbody');
    tbody.innerHTML = '';
    
    if (mismatches.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No mismatches found! 🎉</td></tr>';
        return;
    }
    
    mismatches.forEach((item, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${item.trackingId}</strong></td>
            <td><span class="dsp-badge dsp-${item.scannedDSP.toLowerCase()}">${item.scannedDSP}</span></td>
            <td><span class="dsp-badge dsp-${item.systemDSP.toLowerCase()}">${item.systemDSP}</span></td>
            <td>${item.city}</td>
            <td>${item.postal}</td>
            <td>${item.sortZone}</td>
        `;
        tbody.appendChild(row);
    });
}

function populateMatchesTable(matches) {
    const tbody = document.getElementById('matches-tbody');
    tbody.innerHTML = '';
    
    if (matches.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No matches yet</td></tr>';
        return;
    }
    
    matches.forEach((item, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${item.trackingId}</strong></td>
            <td><span class="dsp-badge dsp-${item.dsp.toLowerCase()}">${item.dsp}</span></td>
            <td>Route ${item.route}</td>
            <td>${item.city}</td>
            <td>${item.sortZone}</td>
        `;
        tbody.appendChild(row);
    });
}

function populateNotScannedTable(notScanned) {
    const tbody = document.getElementById('not-scanned-tbody');
    tbody.innerHTML = '';
    
    if (notScanned.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">All packages scanned! 🎉</td></tr>';
        return;
    }
    
    notScanned.forEach((item, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${item.trackingId}</strong></td>
            <td><span class="dsp-badge dsp-${item.systemDSP.toLowerCase()}">${item.systemDSP}</span></td>
            <td>${item.city}</td>
            <td>${item.postal}</td>
            <td>${item.sortZone}</td>
        `;
        tbody.appendChild(row);
    });
}

// ==================== EXPORT FUNCTIONS ====================
function exportScanResults() {
    if (scannedPackages.length === 0) {
        alert('No scanned packages to export');
        return;
    }
    
    let csv = 'Tracking ID,DSP,Route,Route Name,Latitude,Longitude,Address,City,Timestamp\n';
    
    scannedPackages.forEach(pkg => {
        csv += `"${pkg.trackingId}","${pkg.dsp}",${pkg.route},"${pkg.routeName}",${pkg.latitude},${pkg.longitude},"${pkg.address}","${pkg.city}","${pkg.timestamp}"\n`;
    });
    
    downloadCSV(csv, 'scan_results.csv');
}

function exportComparisonReport() {
    if (csvData.length === 0) {
        alert('No comparison data to export');
        return;
    }
    
    // Export comparison results
    let csv = 'Type,Tracking ID,Scanned DSP,System DSP,City,Postal,Sort Zone\n';
    
    csvData.forEach(csvRow => {
        const trackingId = csvRow['Tracking ID'];
        const rawSystemDSP = csvRow['DSP Name'];
        const systemDSP = normalizeDSPName(rawSystemDSP) || 'NOT ASSIGNED';
        const city = csvRow['City'];
        const postal = csvRow['Postal'];
        const sortZone = csvRow['Sort Zone'];
        
        const scannedPkg = scannedPackages.find(p => p.trackingId === trackingId);
        
        let type = '';
        let scannedDSP = '';
        
        if (!scannedPkg) {
            type = 'NOT_SCANNED';
            scannedDSP = 'N/A';
        } else if (scannedPkg.dsp === systemDSP) {
            type = 'MATCH';
            scannedDSP = scannedPkg.dsp;
        } else {
            type = 'MISMATCH';
            scannedDSP = scannedPkg.dsp;
        }
        
        csv += `"${type}","${trackingId}","${scannedDSP}","${systemDSP}","${city}","${postal}","${sortZone}"\n`;
    });
    
    downloadCSV(csv, 'comparison_report.csv');
}

function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ==================== TAB SWITCHING ====================
function switchTab(tabName) {
    // Hide all tab panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Show selected tab panel
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Add active class to clicked button
    event.target.classList.add('active');
}

// ==================== EVENT LISTENERS ====================
function initializeEventListeners() {
    // Report upload button
    document.getElementById('report-upload-btn').addEventListener('click', () => {
        document.getElementById('report-upload').click();
    });
    
    // Report file upload
    document.getElementById('report-upload').addEventListener('change', handleReportUpload);
    
    // Scan button
    document.getElementById('scan-btn').addEventListener('click', () => {
        const trackingId = document.getElementById('tracking-input').value;
        scanPackage(trackingId);
    });
    
    // Enter key for scanning
    document.getElementById('tracking-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const trackingId = e.target.value;
            scanPackage(trackingId);
        }
    });
    
    // Clear all button
    document.getElementById('clear-all-btn').addEventListener('click', clearAllPackages);
    
    // Upload button
    document.getElementById('upload-btn').addEventListener('click', () => {
        document.getElementById('csv-upload').click();
    });
    
    // CSV file upload
    document.getElementById('csv-upload').addEventListener('change', handleCSVUpload);
    
    // Export buttons
    document.getElementById('export-scan-btn').addEventListener('click', exportScanResults);
    document.getElementById('export-comparison-btn').addEventListener('click', exportComparisonReport);
    
    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = e.target.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
}
