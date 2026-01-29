// ==================== FIREBASE & DATA STORAGE ====================
// Firebase will be initialized from index.html
let db = null;

// Session ID to identify different scanning sessions
const SESSION_ID = `session_${new Date().toISOString().split('T')[0]}_${Date.now()}`;

// Wait for Firebase to be ready
function waitForFirebase() {
    return new Promise((resolve) => {
        const checkFirebase = setInterval(() => {
            if (window.firebaseDb) {
                db = window.firebaseDb;
                clearInterval(checkFirebase);
                resolve();
            }
        }, 100);
    });
}

// Known mismatch zones based on historical data
const MISMATCH_ZONES = {
    'MDTR-NALG-Border': {
        description: 'Northern corridor (Bruck, Oberaich, Friesach)',
        polygonDSP: 'MDTR',
        likelyAmazonDSP: 'NALG',
        cities: ['BRUCK AN DER MUR', 'OBERAICH', 'FRIESACH', 'KAPFENBERG'],
        postalCodes: ['8600', '8114'],
        priority: 'HIGH'
    },
    'AMTP-ABFB-Graz': {
        description: 'Graz urban center',
        polygonDSP: 'AMTP',
        likelyAmazonDSP: 'ABFB',
        cities: ['GRAZ'],
        postalCodes: ['8010', '8044', '8047'],
        priority: 'HIGH'
    },
    'ABFB-BBGH-Border': {
        description: 'Southern region (St. Martin)',
        polygonDSP: 'ABFB',
        likelyAmazonDSP: 'BBGH',
        cities: ['ST. MARTIN IM SULMTAL', 'ST MARTIN IM SULMTAL'],
        postalCodes: ['8543'],
        priority: 'MEDIUM'
    },
    'NALG-BBGH-Border': {
        description: 'Graz periphery',
        polygonDSP: 'NALG',
        likelyAmazonDSP: 'BBGH',
        cities: ['GRAZ'],
        postalCodes: ['8054'],
        priority: 'LOW'
    }
};

// ==================== DATA STORAGE ====================
let scannedPackages = [];
let routePolygons = [];
let csvData = [];
let reportData = {}; // Stores all packages from report.csv
let uploadedPolygonData = null; // Stores uploaded polygon JSON
let correctionData = null; // Stores correction JSON
let mismatchHistory = {}; // Historical mismatch data

// Verification Mode
let verificationMode = false;
let mismatchPackages = []; // Packages that mismatched
let verifiedMismatches = new Set(); // Tracking IDs that have been verified

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
document.addEventListener('DOMContentLoaded', async () => {
    await waitForFirebase();
    await loadHistoricalMismatches();
    await loadSharedScannedPackages(); // Load packages from Firebase
    loadRoutePolygons();
    initializeEventListeners();
    
    // Set up real-time listener for scanned packages
    setupRealtimeListener();
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

// ==================== POLYGON UPLOAD & DETECTION ====================
function handlePolygonUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('polygon-file-name').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const jsonData = JSON.parse(e.target.result);
            uploadedPolygonData = jsonData;
            detectDSPsFromPolygon(jsonData);
        } catch (error) {
            showPolygonStatus('Invalid JSON file format', 'error');
        }
    };
    reader.readAsText(file);
}

function detectDSPsFromPolygon(jsonData) {
    if (!jsonData.features || !Array.isArray(jsonData.features)) {
        showPolygonStatus('Invalid GeoJSON structure', 'error');
        return;
    }
    
    const dspRoutes = {};
    
    jsonData.features.forEach(feature => {
        const routeName = feature.properties?.name || 'Unknown';
        
        // Extract DSP from route name (e.g., "1. AMTP - CA_A / CZ_A" -> "AMTP")
        const match = routeName.match(/\d+\.\s*([A-Z]+)/);
        if (match) {
            const dspCode = match[1];
            
            if (!dspRoutes[dspCode]) {
                dspRoutes[dspCode] = {
                    routes: [],
                    count: 0
                };
            }
            
            dspRoutes[dspCode].routes.push(routeName);
            dspRoutes[dspCode].count++;
        }
    });
    
    displayDSPDetection(dspRoutes, jsonData.features.length);
}

function displayDSPDetection(dspRoutes, totalRoutes) {
    const detectionSection = document.getElementById('dsp-detection-section');
    const resultsDiv = document.getElementById('dsp-detection-results');
    
    resultsDiv.innerHTML = '';
    
    // Sort DSPs by name
    const sortedDSPs = Object.keys(dspRoutes).sort();
    
    sortedDSPs.forEach(dspCode => {
        const dspData = dspRoutes[dspCode];
        
        const card = document.createElement('div');
        card.className = 'dsp-card';
        card.innerHTML = `
            <div class="dsp-card-header">
                <span class="dsp-card-name">${dspCode}</span>
                <span class="dsp-card-status detected">✓ Detected</span>
            </div>
            <div class="dsp-card-body">
                <div class="route-count">${dspData.count} route${dspData.count !== 1 ? 's' : ''}</div>
                <ul class="route-list">
                    ${dspData.routes.map(route => `<li>${route}</li>`).join('')}
                </ul>
            </div>
        `;
        resultsDiv.appendChild(card);
    });
    
    detectionSection.style.display = 'block';
    showPolygonStatus(`✓ Successfully detected ${sortedDSPs.length} DSPs with ${totalRoutes} total routes`, 'success');
}

function showPolygonStatus(message, type) {
    const statusDiv = document.getElementById('polygon-status');
    statusDiv.innerHTML = `<div class="status-box status-${type}">${message}</div>`;
}

function confirmPolygons() {
    if (!uploadedPolygonData) {
        alert('No polygon data to confirm');
        return;
    }
    
    // Clear existing polygons and load the uploaded ones
    routePolygons = [];
    
    uploadedPolygonData.features.forEach((feature, index) => {
        const coords = feature.geometry.coordinates[0];
        const routeName = feature.properties?.name || `Route ${index + 1}`;
        const sequenceOrder = feature.properties?.sequenceOrder ?? index;
        
        // Extract DSP from route name
        const match = routeName.match(/\d+\.\s*([A-Z]+)/);
        const dspCode = match ? match[1] : 'UNKNOWN';
        
        routePolygons.push({
            dsp: dspCode,
            routeNumber: sequenceOrder + 1,
            routeName: routeName,
            coordinates: coords
        });
    });
    
    showPolygonStatus(`✓ Successfully loaded ${routePolygons.length} routes! You can now proceed with scanning.`, 'success');
    
    // Hide detection section after confirmation
    setTimeout(() => {
        document.getElementById('dsp-detection-section').style.display = 'none';
    }, 2000);
}

// ==================== POLYGON ERROR REPORTING ====================
function openPolygonErrorModal() {
    const modal = document.getElementById('polygon-error-modal');
    modal.classList.add('show');
    document.getElementById('error-type').value = 'missing';
    document.getElementById('affected-dsp').value = '';
    document.getElementById('error-description').value = '';
    document.getElementById('correction-file-name').textContent = 'No file selected';
    document.getElementById('correction-status').innerHTML = '';
    correctionData = null;
}

function closePolygonErrorModal() {
    const modal = document.getElementById('polygon-error-modal');
    modal.classList.remove('show');
}

function handleCorrectionUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('correction-file-name').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const jsonData = JSON.parse(e.target.result);
            correctionData = jsonData;
            showCorrectionStatus('✓ Correction file loaded successfully', 'success');
        } catch (error) {
            showCorrectionStatus('Invalid JSON file format', 'error');
            correctionData = null;
        }
    };
    reader.readAsText(file);
}

function showCorrectionStatus(message, type) {
    const statusDiv = document.getElementById('correction-status');
    statusDiv.innerHTML = `<div class="status-box status-${type}">${message}</div>`;
}

function applyCorrection() {
    const errorType = document.getElementById('error-type').value;
    const affectedDSP = document.getElementById('affected-dsp').value.trim().toUpperCase();
    const description = document.getElementById('error-description').value.trim();
    
    if (!affectedDSP) {
        showCorrectionStatus('Please specify which DSP is affected', 'error');
        return;
    }
    
    if (!correctionData) {
        showCorrectionStatus('Please upload a correction JSON file', 'error');
        return;
    }
    
    // Remove existing routes for the affected DSP
    routePolygons = routePolygons.filter(route => route.dsp !== affectedDSP);
    
    // Add routes from correction file
    let addedCount = 0;
    correctionData.features.forEach((feature, index) => {
        const coords = feature.geometry.coordinates[0];
        const routeName = feature.properties?.name || `${affectedDSP} Route ${index + 1}`;
        const sequenceOrder = feature.properties?.sequenceOrder ?? index;
        
        routePolygons.push({
            dsp: affectedDSP,
            routeNumber: sequenceOrder + 1,
            routeName: routeName,
            coordinates: coords
        });
        addedCount++;
    });
    
    showCorrectionStatus(`✓ Applied correction: ${addedCount} routes added/updated for ${affectedDSP}`, 'success');
    
    // Update the detection display if it's visible
    if (uploadedPolygonData) {
        // Merge correction data into uploaded polygon data
        if (errorType === 'missing') {
            uploadedPolygonData.features.push(...correctionData.features);
        }
        detectDSPsFromPolygon(uploadedPolygonData);
    }
    
    // Close modal after a short delay
    setTimeout(() => {
        closePolygonErrorModal();
    }, 2000);
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

// ==================== FIREBASE: HISTORICAL MISMATCH TRACKING ====================
async function loadHistoricalMismatches() {
    try {
        // Import Firestore functions
        const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        const querySnapshot = await getDocs(collection(db, 'mismatch_history'));
        mismatchHistory = {};
        
        querySnapshot.forEach((doc) => {
            mismatchHistory[doc.id] = doc.data();
        });
        
        console.log(`Loaded ${Object.keys(mismatchHistory).length} historical mismatch records`);
    } catch (error) {
        console.error('Error loading historical mismatches:', error);
        // Fallback to localStorage
        const saved = localStorage.getItem('mismatchHistory');
        if (saved) {
            mismatchHistory = JSON.parse(saved);
        }
    }
}

async function saveMismatchToHistory(mismatchData) {
    try {
        // Import Firestore functions
        const { collection, doc, setDoc, updateDoc, increment } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        // Create unique key based on coordinates (rounded to ~100m precision)
        const coordKey = `${mismatchData.lat.toFixed(3)}_${mismatchData.lon.toFixed(3)}`;
        
        const docData = {
            trackingId: mismatchData.trackingId,
            polygonDSP: mismatchData.polygonDSP,
            amazonDSP: mismatchData.amazonDSP,
            city: mismatchData.city,
            postal: mismatchData.postal,
            latitude: mismatchData.lat,
            longitude: mismatchData.lon,
            lastSeen: new Date().toISOString(),
            count: 1
        };
        
        // Check if this location already exists
        if (mismatchHistory[coordKey]) {
            // Update existing record
            await updateDoc(doc(db, 'mismatch_history', coordKey), {
                lastSeen: new Date().toISOString(),
                count: increment(1),
                trackingId: mismatchData.trackingId // Update with latest tracking ID
            });
            mismatchHistory[coordKey].count++;
            mismatchHistory[coordKey].lastSeen = new Date().toISOString();
        } else {
            // Create new record
            await setDoc(doc(db, 'mismatch_history', coordKey), docData);
            mismatchHistory[coordKey] = docData;
        }
        
        console.log(`Saved mismatch to Firebase: ${mismatchData.trackingId}`);
        
        // Also save to localStorage as backup
        localStorage.setItem('mismatchHistory', JSON.stringify(mismatchHistory));
        
    } catch (error) {
        console.error('Error saving mismatch to Firebase:', error);
        // Fallback to localStorage only
        const coordKey = `${mismatchData.lat.toFixed(3)}_${mismatchData.lon.toFixed(3)}`;
        if (!mismatchHistory[coordKey]) {
            mismatchHistory[coordKey] = {
                ...mismatchData,
                lastSeen: new Date().toISOString(),
                count: 1
            };
        } else {
            mismatchHistory[coordKey].count++;
            mismatchHistory[coordKey].lastSeen = new Date().toISOString();
        }
        localStorage.setItem('mismatchHistory', JSON.stringify(mismatchHistory));
    }
}

// ==================== PRIORITY 1: SMART WARNING SYSTEM ====================
function checkMismatchZone(city, postal, detectedDSP) {
    const cityUpper = city.toUpperCase().trim();
    const postalClean = postal.trim();
    
    for (const [zoneName, zone] of Object.entries(MISMATCH_ZONES)) {
        // Check if this package is in a known mismatch zone
        const cityMatch = zone.cities.some(c => cityUpper.includes(c) || c.includes(cityUpper));
        const postalMatch = zone.postalCodes.includes(postalClean);
        
        if ((cityMatch || postalMatch) && detectedDSP === zone.polygonDSP) {
            return {
                warning: true,
                zoneName: zoneName,
                description: zone.description,
                polygonDSP: zone.polygonDSP,
                likelyAmazonDSP: zone.likelyAmazonDSP,
                priority: zone.priority
            };
        }
    }
    
    return { warning: false };
}

// ==================== PRIORITY 2: CONFIDENCE SCORE SYSTEM ====================
function calculateConfidenceScore(packageInfo, detectedDSP, coords) {
    let confidence = 100;
    let reasons = [];
    
    // Check if in known mismatch zone
    const mismatchZone = checkMismatchZone(packageInfo.city, packageInfo.postal, detectedDSP);
    if (mismatchZone.warning) {
        if (mismatchZone.priority === 'HIGH') {
            confidence -= 40;
            reasons.push(`Known ${mismatchZone.priority} mismatch zone: ${mismatchZone.description}`);
        } else if (mismatchZone.priority === 'MEDIUM') {
            confidence -= 25;
            reasons.push(`Known ${mismatchZone.priority} mismatch zone: ${mismatchZone.description}`);
        } else {
            confidence -= 15;
            reasons.push(`Known ${mismatchZone.priority} mismatch zone: ${mismatchZone.description}`);
        }
    }
    
    // Check historical mismatches
    const coordKey = `${coords.latitude.toFixed(3)}_${coords.longitude.toFixed(3)}`;
    const history = mismatchHistory[coordKey];
    
    if (history && history.polygonDSP === detectedDSP) {
        const historyPenalty = Math.min(30, history.count * 10);
        confidence -= historyPenalty;
        reasons.push(`Historical mismatches: ${history.count}x (last: ${new Date(history.lastSeen).toLocaleDateString()})`);
    }
    
    // Ensure confidence doesn't go below 0
    confidence = Math.max(0, confidence);
    
    return {
        score: confidence,
        level: confidence >= 85 ? 'HIGH' : confidence >= 60 ? 'MEDIUM' : 'LOW',
        reasons: reasons
    };
}

// ==================== PRIORITY 3: HISTORICAL LEARNING ====================
function checkHistoricalMismatch(coords, detectedDSP) {
    const coordKey = `${coords.latitude.toFixed(3)}_${coords.longitude.toFixed(3)}`;
    const history = mismatchHistory[coordKey];
    
    if (history && history.polygonDSP === detectedDSP && history.count >= 1) {
        return {
            hasHistory: true,
            count: history.count,
            amazonDSP: history.amazonDSP,
            lastSeen: history.lastSeen,
            message: `This location has mismatched ${history.count} time${history.count > 1 ? 's' : ''} before. ` +
                     `Amazon assigned to ${history.amazonDSP} instead of ${history.polygonDSP}.`
        };
    }
    
    return { hasHistory: false };
}

// ==================== DISPLAY CONFIDENCE & WARNINGS ====================
function displayConfidenceScore(confidence, packageInfo) {
    const confidenceDiv = document.getElementById('scan-confidence');
    
    let icon = '';
    let className = '';
    let levelText = '';
    
    if (confidence.level === 'HIGH') {
        icon = '✅';
        className = 'confidence-high';
        levelText = 'High Confidence';
    } else if (confidence.level === 'MEDIUM') {
        icon = '⚠️';
        className = 'confidence-medium';
        levelText = 'Medium Confidence';
    } else {
        icon = '🔴';
        className = 'confidence-low';
        levelText = 'Low Confidence';
    }
    
    let html = `
        <div class="${className}">
            <div class="confidence-header">
                <span class="confidence-icon">${icon}</span>
                <span>${levelText} (${confidence.score}%)</span>
            </div>
    `;
    
    if (confidence.reasons.length > 0) {
        html += `<div class="confidence-details">`;
        confidence.reasons.forEach(reason => {
            html += `<div>• ${reason}</div>`;
        });
        html += `</div>`;
    }
    
    html += `</div>`;
    
    confidenceDiv.innerHTML = html;
    confidenceDiv.style.display = 'block';
    
    // Auto-hide after 8 seconds for high confidence
    if (confidence.level === 'HIGH') {
        setTimeout(() => {
            confidenceDiv.style.display = 'none';
        }, 8000);
    }
}

function displayMismatchWarning(mismatchZone, historicalData, packageInfo, detectedDSP) {
    const warningDiv = document.getElementById('scan-warning');
    
    let suggestedDSP = mismatchZone.likelyAmazonDSP;
    
    // If we have historical data, use that instead
    if (historicalData && historicalData.hasHistory) {
        suggestedDSP = historicalData.amazonDSP;
    }
    
    let html = `
        <div class="warning-header">
            <span class="warning-icon">⚠️</span>
            <span>LIKELY MISMATCH DETECTED</span>
            ${historicalData && historicalData.hasHistory ? 
                `<span class="historical-badge">🔄 ${historicalData.count}x Historical</span>` : ''}
        </div>
        <div style="margin-top: 0.5rem; font-weight: 600;">
            ${mismatchZone.description}
        </div>
        <div class="warning-details">
            <div class="warning-dsp-comparison">
                <div class="warning-dsp-item">
                    <div class="warning-dsp-label">Your Polygon Says:</div>
                    <div class="warning-dsp-value" style="color: var(--text-muted);">${detectedDSP}</div>
                </div>
                <div class="warning-dsp-item">
                    <div class="warning-dsp-label">Amazon Usually Assigns:</div>
                    <div class="warning-dsp-value" style="color: var(--danger);">${suggestedDSP}</div>
                </div>
            </div>
            ${historicalData && historicalData.hasHistory ? `
                <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #FDE68A;">
                    <strong>📊 Historical Data:</strong> ${historicalData.message}
                </div>
            ` : ''}
            <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #FDE68A;">
                <strong>⚠️ Recommendation:</strong> Verify this package in the Search Results CSV before final processing to ensure correct DSP assignment.
            </div>
        </div>
    `;
    
    warningDiv.innerHTML = html;
    warningDiv.style.display = 'block';
    
    // Don't auto-hide warnings - user needs to see them
}

// ==================== SCAN PACKAGE ====================
async function scanPackage(trackingId) {
    if (!trackingId || trackingId.trim() === '') {
        showScanResult('Please enter a tracking ID', 'error');
        return false;
    }
    
    trackingId = trackingId.trim().toUpperCase();
    
    // Check if report is loaded
    if (Object.keys(reportData).length === 0) {
        showScanResult('Please upload the report.csv file first!', 'error');
        return false;
    }
    
    // Check if already scanned
    if (scannedPackages.find(p => p.trackingId === trackingId)) {
        showScanResult(`Package ${trackingId} already scanned!`, 'error');
        return false;
    }
    
    // Get package info from uploaded report
    const packageInfo = getPackageCoordinates(trackingId);
    
    if (!packageInfo) {
        showScanResult(`Package ${trackingId} not found in uploaded report`, 'error');
        return false;
    }
    
    const dspInfo = findDSPForCoordinates(packageInfo.latitude, packageInfo.longitude);
    
    if (!dspInfo) {
        showScanResult(`Package ${trackingId} location outside all route boundaries`, 'error');
        return false;
    }
    
    // ==================== PRIORITY 2: CALCULATE CONFIDENCE SCORE ====================
    const confidence = calculateConfidenceScore(packageInfo, dspInfo.dsp, packageInfo);
    
    // ==================== PRIORITY 1: CHECK FOR MISMATCH WARNINGS ====================
    const mismatchZone = checkMismatchZone(packageInfo.city, packageInfo.postal, dspInfo.dsp);
    
    // ==================== PRIORITY 3: CHECK HISTORICAL DATA ====================
    const historicalData = checkHistoricalMismatch(packageInfo, dspInfo.dsp);
    
    // Display confidence score
    displayConfidenceScore(confidence, packageInfo);
    
    // Display warning if in mismatch zone or has historical mismatches
    if (mismatchZone.warning || historicalData.hasHistory) {
        displayMismatchWarning(mismatchZone, historicalData, packageInfo, dspInfo.dsp);
    } else {
        // Clear warning if no issues
        document.getElementById('scan-warning').style.display = 'none';
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
        timestamp: new Date().toLocaleString(),
        confidence: confidence.score,
        confidenceLevel: confidence.level,
        hasWarning: mismatchZone.warning || historicalData.hasHistory
    };
    
    scannedPackages.push(scannedPackage);
    
    // Save to Firebase (shared with all users)
    await saveScannedPackageToFirebase(scannedPackage);
    
    // Also save to localStorage as backup
    saveScannedPackages();
    
    updateScannedTable();
    
    let resultMessage = `✓ ${trackingId} → ${dspInfo.dsp} (Route ${dspInfo.route})`;
    if (confidence.level === 'LOW') {
        resultMessage += ` - ⚠️ Low Confidence`;
    }
    
    showScanResult(resultMessage, confidence.level === 'LOW' ? 'error' : 'success');
    
    // Clear input and refocus
    document.getElementById('tracking-input').value = '';
    document.getElementById('tracking-input').focus();
    
    return true;
}

// ==================== BULK SCAN PACKAGES ====================
async function processBulkScan() {
    const textarea = document.getElementById('bulk-tracking-input');
    const text = textarea.value.trim();
    
    if (!text) {
        showBulkScanStatus('Please enter tracking IDs', 'error');
        return;
    }
    
    // Parse tracking IDs - support newlines, commas, spaces, and tabs
    const trackingIds = text
        .split(/[\n,\s\t]+/)
        .map(id => id.trim())
        .filter(id => id.length > 0);
    
    if (trackingIds.length === 0) {
        showBulkScanStatus('No valid tracking IDs found', 'error');
        return;
    }
    
    // Process all tracking IDs
    let successCount = 0;
    let failedCount = 0;
    let duplicateCount = 0;
    let lowConfidenceCount = 0;
    const failedIds = [];
    const lowConfidenceIds = [];
    
    trackingIds.forEach((trackingId, index) => {
        const cleanId = trackingId.trim().toUpperCase();
        
        // Check if already scanned
        if (scannedPackages.find(p => p.trackingId === cleanId)) {
            duplicateCount++;
            return;
        }
        
        // Get package info from uploaded report
        const packageInfo = getPackageCoordinates(cleanId);
        
        if (!packageInfo) {
            failedCount++;
            failedIds.push(`${cleanId} (not in report)`);
            return;
        }
        
        const dspInfo = findDSPForCoordinates(packageInfo.latitude, packageInfo.longitude);
        
        if (!dspInfo) {
            failedCount++;
            failedIds.push(`${cleanId} (outside routes)`);
            return;
        }
        
        // Calculate confidence
        const confidence = calculateConfidenceScore(packageInfo, dspInfo.dsp, packageInfo);
        const mismatchZone = checkMismatchZone(packageInfo.city, packageInfo.postal, dspInfo.dsp);
        const historicalData = checkHistoricalMismatch(packageInfo, dspInfo.dsp);
        
        // Track low confidence packages
        if (confidence.level === 'LOW' || mismatchZone.warning) {
            lowConfidenceCount++;
            lowConfidenceIds.push(`${cleanId} (${packageInfo.city})`);
        }
        
        // Successfully scan the package
        const scannedPackage = {
            trackingId: cleanId,
            dsp: dspInfo.dsp,
            route: dspInfo.route,
            routeName: dspInfo.routeName,
            latitude: packageInfo.latitude,
            longitude: packageInfo.longitude,
            address: packageInfo.address,
            city: packageInfo.city,
            timestamp: new Date().toLocaleString(),
            confidence: confidence.score,
            confidenceLevel: confidence.level,
            hasWarning: mismatchZone.warning || historicalData.hasHistory
        };
        
        scannedPackages.push(scannedPackage);
        successCount++;
    });
    
    // Save all to Firebase (in batch)
    const savePromises = [];
    scannedPackages.slice(-successCount).forEach(pkg => {
        savePromises.push(saveScannedPackageToFirebase(pkg));
    });
    
    try {
        await Promise.all(savePromises);
        console.log(`Saved ${successCount} packages to Firebase`);
    } catch (error) {
        console.error('Error saving bulk packages to Firebase:', error);
    }
    
    // Also save to localStorage as backup
    saveScannedPackages();
    
    updateScannedTable();
    
    // Build status message
    let statusMessage = `<strong>Bulk Scan Complete!</strong><br>`;
    statusMessage += `✓ Successfully scanned: ${successCount}<br>`;
    if (duplicateCount > 0) {
        statusMessage += `⚠ Already scanned: ${duplicateCount}<br>`;
    }
    if (lowConfidenceCount > 0) {
        statusMessage += `🔴 Low confidence warnings: ${lowConfidenceCount}<br>`;
        if (lowConfidenceIds.length <= 5) {
            statusMessage += `<div style="margin-top: 10px; font-size: 0.85em; color: var(--danger);">⚠️ Review these: ${lowConfidenceIds.join(', ')}</div>`;
        } else {
            statusMessage += `<div style="margin-top: 10px; font-size: 0.85em; color: var(--danger);">⚠️ ${lowConfidenceCount} packages need review. Check the scanned list.</div>`;
        }
    }
    if (failedCount > 0) {
        statusMessage += `✗ Failed: ${failedCount}<br>`;
        if (failedIds.length > 0 && failedIds.length <= 10) {
            statusMessage += `<div style="margin-top: 10px; font-size: 0.85em;">Failed IDs: ${failedIds.join(', ')}</div>`;
        } else if (failedIds.length > 10) {
            statusMessage += `<div style="margin-top: 10px; font-size: 0.85em;">Failed IDs (first 10): ${failedIds.slice(0, 10).join(', ')}...</div>`;
        }
    }
    
    showBulkScanStatus(statusMessage, successCount > 0 ? (lowConfidenceCount > 0 ? 'error' : 'success') : 'error');
    
    // Don't auto-close if there are low confidence packages
    if (failedCount === 0 && lowConfidenceCount === 0) {
        setTimeout(() => {
            closeBulkScanModal();
        }, 2000);
    }
}

function showBulkScanStatus(message, type) {
    const statusDiv = document.getElementById('bulk-scan-status');
    statusDiv.innerHTML = `<div class="result-box result-${type}">${message}</div>`;
}

// ==================== BULK SCAN MODAL ====================
function openBulkScanModal() {
    const modal = document.getElementById('bulk-scan-modal');
    modal.classList.add('show');
    document.getElementById('bulk-tracking-input').value = '';
    document.getElementById('bulk-scan-status').innerHTML = '';
    document.getElementById('bulk-tracking-input').focus();
}

function closeBulkScanModal() {
    const modal = document.getElementById('bulk-scan-modal');
    modal.classList.remove('show');
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
            <td><button class="delete-btn" data-index="${index}">Delete</button></td>
        `;
        tbody.appendChild(row);
    });
    
    // Add event listeners to delete buttons
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.getAttribute('data-index'));
            await deletePackage(index);
        });
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
async function deletePackage(index) {
    if (confirm('Are you sure you want to delete this package?')) {
        const trackingId = scannedPackages[index].trackingId;
        
        scannedPackages.splice(index, 1);
        
        // Delete from Firebase
        await deleteScannedPackageFromFirebase(trackingId);
        
        // Also update localStorage
        saveScannedPackages();
        
        updateScannedTable();
    }
}

// ==================== CLEAR ALL ====================
async function clearAllPackages() {
    if (confirm('Are you sure you want to clear all scanned packages? This will affect all users!')) {
        scannedPackages = [];
        
        // Clear from Firebase
        await clearAllScannedPackagesFromFirebase();
        
        // Also clear localStorage
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

// ==================== FIREBASE: SHARED SCANNED PACKAGES ====================
async function loadSharedScannedPackages() {
    try {
        const { collection, query, where, getDocs } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        // Get today's date
        const today = new Date().toISOString().split('T')[0];
        
        // Simplified query - just filter by date (no ordering to avoid index requirement)
        const q = query(
            collection(db, 'scanned_packages'),
            where('scanDate', '==', today)
        );
        
        const querySnapshot = await getDocs(q);
        scannedPackages = [];
        
        querySnapshot.forEach((doc) => {
            scannedPackages.push(doc.data());
        });
        
        // Sort locally by timestamp (newest first)
        scannedPackages.sort((a, b) => {
            const timeA = new Date(a.timestamp).getTime();
            const timeB = new Date(b.timestamp).getTime();
            return timeB - timeA;
        });
        
        updateScannedTable();
        
        console.log(`Loaded ${scannedPackages.length} shared scanned packages from Firebase`);
        
    } catch (error) {
        console.error('Error loading shared scanned packages:', error);
        
        // If it's an index error, show helpful message
        if (error.message && error.message.includes('index')) {
            console.warn('Firebase index required. Creating it now will enable faster queries.');
            console.warn('For now, loading all documents and filtering locally...');
            
            // Fallback: load all documents without filter
            try {
                const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
                const querySnapshot = await getDocs(collection(db, 'scanned_packages'));
                
                const today = new Date().toISOString().split('T')[0];
                scannedPackages = [];
                
                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    // Filter locally for today
                    if (data.scanDate === today) {
                        scannedPackages.push(data);
                    }
                });
                
                scannedPackages.sort((a, b) => {
                    const timeA = new Date(a.timestamp).getTime();
                    const timeB = new Date(b.timestamp).getTime();
                    return timeB - timeA;
                });
                
                updateScannedTable();
                console.log(`Loaded ${scannedPackages.length} packages (fallback mode)`);
                
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
                // Final fallback to localStorage
                loadScannedPackages();
            }
        } else {
            // Fallback to localStorage for other errors
            loadScannedPackages();
        }
    }
}

async function saveScannedPackageToFirebase(scannedPackage) {
    try {
        const { collection, doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        // Use tracking ID as document ID for easy deduplication
        const docId = scannedPackage.trackingId;
        
        // Add metadata
        const packageData = {
            ...scannedPackage,
            scanDate: new Date().toISOString().split('T')[0], // Today's date
            sessionId: SESSION_ID,
            uploadedAt: new Date().toISOString()
        };
        
        await setDoc(doc(db, 'scanned_packages', docId), packageData);
        
        console.log(`Saved package to Firebase: ${scannedPackage.trackingId}`);
        
    } catch (error) {
        console.error('Error saving package to Firebase:', error);
        // Still save to localStorage as backup
        saveScannedPackages();
    }
}

async function deleteScannedPackageFromFirebase(trackingId) {
    try {
        const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        await deleteDoc(doc(db, 'scanned_packages', trackingId));
        
        console.log(`Deleted package from Firebase: ${trackingId}`);
        
    } catch (error) {
        console.error('Error deleting package from Firebase:', error);
    }
}

async function clearAllScannedPackagesFromFirebase() {
    try {
        const { collection, query, where, getDocs, deleteDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        // Get today's date
        const today = new Date().toISOString().split('T')[0];
        
        // Find all packages from today
        const q = query(
            collection(db, 'scanned_packages'),
            where('scanDate', '==', today)
        );
        
        const querySnapshot = await getDocs(q);
        
        // Delete all documents
        const deletePromises = [];
        querySnapshot.forEach((document) => {
            deletePromises.push(deleteDoc(doc(db, 'scanned_packages', document.id)));
        });
        
        await Promise.all(deletePromises);
        
        console.log(`Cleared ${deletePromises.length} packages from Firebase`);
        
    } catch (error) {
        console.error('Error clearing packages from Firebase:', error);
    }
}

// Real-time listener for new scans from other users
async function setupRealtimeListener() {
    try {
        const { collection, query, where, onSnapshot } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        
        const today = new Date().toISOString().split('T')[0];
        
        const q = query(
            collection(db, 'scanned_packages'),
            where('scanDate', '==', today)
        );
        
        onSnapshot(q, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added' && change.doc.data().sessionId !== SESSION_ID) {
                    // Another user added a package
                    const newPackage = change.doc.data();
                    
                    // Check if we don't already have it
                    if (!scannedPackages.find(p => p.trackingId === newPackage.trackingId)) {
                        scannedPackages.unshift(newPackage); // Add to beginning
                        updateScannedTable();
                        
                        // Show notification
                        showScanResult(`📦 New scan from another user: ${newPackage.trackingId} → ${newPackage.dsp}`, 'success');
                        
                        // Pulse the sync indicator
                        updateSyncStatus('active');
                    }
                }
                
                if (change.type === 'removed') {
                    // Package was deleted
                    const trackingId = change.doc.id;
                    scannedPackages = scannedPackages.filter(p => p.trackingId !== trackingId);
                    updateScannedTable();
                }
            });
        });
        
        console.log('Real-time listener active - you will see scans from other users!');
        updateSyncStatus('active');
        
    } catch (error) {
        console.error('Error setting up real-time listener:', error);
        updateSyncStatus('error');
    }
}

function updateSyncStatus(status) {
    const syncStatusEl = document.getElementById('sync-status');
    if (!syncStatusEl) return;
    
    syncStatusEl.classList.remove('syncing', 'error');
    
    if (status === 'syncing') {
        syncStatusEl.classList.add('syncing');
        syncStatusEl.querySelector('span').textContent = 'Syncing...';
    } else if (status === 'error') {
        syncStatusEl.classList.add('error');
        syncStatusEl.querySelector('span').textContent = 'Offline';
    } else {
        syncStatusEl.querySelector('span').textContent = 'Live Sync';
    }
}

// ==================== LOCAL STORAGE (BACKUP) ====================
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
            const mismatchData = {
                trackingId,
                scannedDSP: scannedPkg.dsp,
                systemDSP: systemDSP || 'NOT ASSIGNED',
                city,
                postal,
                sortZone
            };
            mismatches.push(mismatchData);
            
            // ==================== PRIORITY 3: SAVE MISMATCH TO FIREBASE ====================
            // Save this mismatch to historical database
            saveMismatchToHistory({
                trackingId: trackingId,
                polygonDSP: scannedPkg.dsp,
                amazonDSP: systemDSP,
                city: city,
                postal: postal,
                lat: scannedPkg.latitude,
                lon: scannedPkg.longitude
            });
        }
    });
    
    displayComparisonResults(matches, mismatches, notScanned);
}

// ==================== VERIFICATION MODE ====================
function enterVerificationMode() {
    if (mismatchPackages.length === 0) {
        alert('No mismatches to verify. Upload Search Results CSV first.');
        return;
    }
    
    verificationMode = true;
    verifiedMismatches.clear();
    
    // Hide normal scanning section
    document.getElementById('scanning-section').style.display = 'none';
    document.getElementById('verification-section').style.display = 'none';
    
    // Show verification mode section
    document.getElementById('verification-mode-section').style.display = 'block';
    
    // Update status
    updateVerificationStatus();
    
    // Populate mismatch table
    populateMismatchVerificationTable();
    
    // Focus on input
    document.getElementById('verification-input').focus();
    
    // Scroll to verification section
    document.getElementById('verification-mode-section').scrollIntoView({ behavior: 'smooth' });
}

function exitVerificationMode() {
    verificationMode = false;
    
    // Show normal sections
    document.getElementById('scanning-section').style.display = 'block';
    document.getElementById('verification-section').style.display = 'block';
    
    // Hide verification mode section
    document.getElementById('verification-mode-section').style.display = 'none';
    
    // Clear input
    document.getElementById('verification-input').value = '';
    document.getElementById('verification-result').innerHTML = '';
}

function updateVerificationStatus() {
    document.getElementById('mismatch-total').textContent = mismatchPackages.length;
    document.getElementById('verified-count').textContent = verifiedMismatches.size;
    document.getElementById('remaining-count').textContent = mismatchPackages.length - verifiedMismatches.size;
}

function populateMismatchVerificationTable() {
    const tbody = document.getElementById('mismatch-verification-tbody');
    tbody.innerHTML = '';
    
    if (mismatchPackages.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No mismatches found</td></tr>';
        return;
    }
    
    mismatchPackages.forEach((item, index) => {
        const isVerified = verifiedMismatches.has(item.trackingId);
        const statusClass = isVerified ? 'success' : 'pending';
        const statusText = isVerified ? '✓ Verified' : 'Pending';
        
        const row = document.createElement('tr');
        row.className = isVerified ? 'verified-row' : '';
        row.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${item.trackingId}</strong></td>
            <td><span class="dsp-badge dsp-${item.scannedDSP.toLowerCase()}">${item.scannedDSP}</span></td>
            <td><span class="dsp-badge dsp-${item.systemDSP.toLowerCase()}">${item.systemDSP}</span></td>
            <td>${item.city}</td>
            <td><span class="status-badge status-${statusClass}">${statusText}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function verifyPackage(trackingId) {
    if (!trackingId || trackingId.trim() === '') {
        showVerificationResult('Please enter a tracking ID', 'error');
        return;
    }
    
    trackingId = trackingId.trim().toUpperCase();
    
    // Check if this package is in the mismatch list
    const mismatch = mismatchPackages.find(m => m.trackingId === trackingId);
    
    if (mismatch) {
        // THIS IS THE ONE!
        verifiedMismatches.add(trackingId);
        updateVerificationStatus();
        populateMismatchVerificationTable();
        
        showVerificationResult({
            type: 'match',
            trackingId: trackingId,
            scannedDSP: mismatch.scannedDSP,
            systemDSP: mismatch.systemDSP,
            city: mismatch.city,
            postal: mismatch.postal
        });
        
        // Auto-clear input after 3 seconds
        setTimeout(() => {
            document.getElementById('verification-input').value = '';
            document.getElementById('verification-input').focus();
        }, 3000);
        
    } else if (verifiedMismatches.has(trackingId)) {
        // Already verified this one
        showVerificationResult({
            type: 'already',
            trackingId: trackingId
        });
        
        setTimeout(() => {
            document.getElementById('verification-input').value = '';
            document.getElementById('verification-input').focus();
        }, 2000);
        
    } else {
        // Not in mismatch list - this package matched correctly
        showVerificationResult({
            type: 'no-match',
            trackingId: trackingId
        });
        
        setTimeout(() => {
            document.getElementById('verification-input').value = '';
            document.getElementById('verification-input').focus();
        }, 2000);
    }
}

function showVerificationResult(data) {
    const resultDiv = document.getElementById('verification-result');
    
    if (typeof data === 'string') {
        // Simple error message
        resultDiv.innerHTML = `<div class="result-box result-error">${data}</div>`;
        return;
    }
    
    if (data.type === 'match') {
        // FOUND A MISMATCH!
        resultDiv.innerHTML = `
            <div class="verification-match">
                <h2>🎯 THIS IS THE ONE!</h2>
                <div class="match-details">
                    <div style="font-size: 1.3rem; margin-bottom: 1rem;">
                        <strong>Package: ${data.trackingId}</strong>
                    </div>
                    <div style="font-size: 1rem; margin-bottom: 1rem;">
                        ${data.city} ${data.postal}
                    </div>
                    <div class="dsp-comparison">
                        <div class="dsp-box">
                            <div style="font-size: 0.8rem; opacity: 0.7;">Your Scan</div>
                            ${data.scannedDSP}
                        </div>
                        <div style="font-size: 2rem; align-self: center;">→</div>
                        <div class="dsp-box">
                            <div style="font-size: 0.8rem; opacity: 0.7;">Amazon System</div>
                            ${data.systemDSP}
                        </div>
                    </div>
                    <div style="margin-top: 1.5rem; font-size: 1.1rem;">
                        ✓ Verified - Move to ${data.systemDSP} staging area
                    </div>
                </div>
            </div>
        `;
    } else if (data.type === 'already') {
        resultDiv.innerHTML = `
            <div class="verification-already">
                <strong>⚠️ Already Verified</strong><br>
                Package ${data.trackingId} was already checked.
            </div>
        `;
    } else if (data.type === 'no-match') {
        resultDiv.innerHTML = `
            <div class="verification-no-match">
                <strong>✓ Not a Mismatch</strong><br>
                Package ${data.trackingId} was correctly sorted.
            </div>
        `;
    }
    
    // Auto-clear after timeout
    setTimeout(() => {
        if (data.type !== 'match') {
            resultDiv.innerHTML = '';
        }
    }, 3000);
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
    
    // Store mismatches for verification mode
    mismatchPackages = mismatches;
    
    // Update stats
    document.getElementById('total-compared').textContent = csvData.length;
    document.getElementById('matches-count').textContent = matches.length;
    document.getElementById('mismatches-count').textContent = mismatches.length;
    document.getElementById('not-scanned-count').textContent = notScanned.length;
    
    // Show verification mode trigger if there are mismatches
    if (mismatches.length > 0) {
        document.getElementById('verification-mode-trigger').style.display = 'block';
        document.getElementById('trigger-mismatch-count').textContent = mismatches.length;
    } else {
        document.getElementById('verification-mode-trigger').style.display = 'none';
    }
    
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
    // Polygon upload button
    document.getElementById('polygon-upload-btn').addEventListener('click', () => {
        document.getElementById('polygon-upload').click();
    });
    
    // Polygon file upload
    document.getElementById('polygon-upload').addEventListener('change', handlePolygonUpload);
    
    // Confirm polygons button
    document.getElementById('confirm-polygons-btn').addEventListener('click', confirmPolygons);
    
    // Report polygon error button
    document.getElementById('report-polygon-error-btn').addEventListener('click', openPolygonErrorModal);
    
    // Polygon error modal buttons
    document.getElementById('close-error-modal').addEventListener('click', closePolygonErrorModal);
    document.getElementById('cancel-error-btn').addEventListener('click', closePolygonErrorModal);
    
    // Correction upload button
    document.getElementById('correction-upload-btn').addEventListener('click', () => {
        document.getElementById('correction-upload').click();
    });
    
    // Correction file upload
    document.getElementById('correction-upload').addEventListener('change', handleCorrectionUpload);
    
    // Apply correction button
    document.getElementById('apply-correction-btn').addEventListener('click', applyCorrection);
    
    // Close error modal when clicking outside
    document.getElementById('polygon-error-modal').addEventListener('click', (e) => {
        if (e.target.id === 'polygon-error-modal') {
            closePolygonErrorModal();
        }
    });
    
    // Report upload button
    document.getElementById('report-upload-btn').addEventListener('click', () => {
        document.getElementById('report-upload').click();
    });
    
    // Report file upload
    document.getElementById('report-upload').addEventListener('change', handleReportUpload);
    
    // Scan button
    document.getElementById('scan-btn').addEventListener('click', async () => {
        const trackingId = document.getElementById('tracking-input').value;
        await scanPackage(trackingId);
    });
    
    // Enter key for scanning
    document.getElementById('tracking-input').addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            const trackingId = e.target.value;
            await scanPackage(trackingId);
        }
    });
    
    // Bulk scan button
    document.getElementById('bulk-scan-btn').addEventListener('click', openBulkScanModal);
    
    // Bulk scan modal buttons
    document.getElementById('close-modal').addEventListener('click', closeBulkScanModal);
    document.getElementById('cancel-bulk-btn').addEventListener('click', closeBulkScanModal);
    document.getElementById('process-bulk-btn').addEventListener('click', async () => {
        await processBulkScan();
    });
    
    // Close modal when clicking outside
    document.getElementById('bulk-scan-modal').addEventListener('click', (e) => {
        if (e.target.id === 'bulk-scan-modal') {
            closeBulkScanModal();
        }
    });
    
    // Clear all button
    document.getElementById('clear-all-btn').addEventListener('click', async () => {
        await clearAllPackages();
    });
    
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
    
    // Verification Mode buttons
    document.getElementById('enter-verification-mode-btn').addEventListener('click', enterVerificationMode);
    document.getElementById('exit-verification-btn').addEventListener('click', exitVerificationMode);
    
    // Verification scan button
    document.getElementById('verify-scan-btn').addEventListener('click', () => {
        const trackingId = document.getElementById('verification-input').value;
        verifyPackage(trackingId);
    });
    
    // Verification enter key
    document.getElementById('verification-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const trackingId = e.target.value;
            verifyPackage(trackingId);
        }
    });
}
