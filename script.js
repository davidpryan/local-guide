let userLocation = null;
let locations = [];
let geocodeCache = {};

// Load geocode cache from localStorage
function loadCache() {
    try {
        const cached = localStorage.getItem('geocodeCache');
        if (cached) {
            geocodeCache = JSON.parse(cached);
        }
    } catch (error) {
        console.error('Failed to load cache:', error);
    }
}

// Save geocode cache to localStorage
function saveCache() {
    try {
        localStorage.setItem('geocodeCache', JSON.stringify(geocodeCache));
    } catch (error) {
        console.error('Failed to save cache:', error);
    }
}

// Get user's current location
function getUserLocation() {
    return new Promise((resolve, reject) => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                position => resolve({
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                }),
                error => reject(error)
            );
        } else {
            reject(new Error('Geolocation not supported'));
        }
    });
}

// Extract coordinates from Google Maps URL
function extractCoordinatesSync(url) {
    // Handle various Google Maps URL formats
    // Format 1: maps.google.com/?q=lat,lng
    let match = url.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (match) {
        return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
    }

    // Format 2: @lat,lng
    match = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (match) {
        return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
    }

    // Format 3: /place/.../@lat,lng
    match = url.match(/place\/[^/]+\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (match) {
        return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
    }

    // Format 4: ll=lat,lng
    match = url.match(/[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (match) {
        return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
    }

    return null;
}

// Geocode a place name with caching and parallel support
async function geocodePlaceName(placeName) {
    // Check cache first
    if (geocodeCache[placeName]) {
        return geocodeCache[placeName];
    }

    try {
        // Use Photon geocoding API (based on OpenStreetMap data)
        const response = await fetch(
            `https://photon.komoot.io/api/?q=${encodeURIComponent(placeName)}&limit=1`,
            { method: 'GET' }
        );
        
        if (!response.ok) {
            throw new Error('Geocoding service error');
        }
        
        const data = await response.json();
        if (data && data.features && data.features.length > 0) {
            const coords = data.features[0].geometry.coordinates;
            const result = {
                lat: coords[1],  // GeoJSON uses [lng, lat] order
                lng: coords[0]
            };
            
            // Cache the result
            geocodeCache[placeName] = result;
            saveCache();
            
            return result;
        }
    } catch (error) {
        console.error('Geocoding error for', placeName, ':', error);
        
        // Fallback: try Nominatim
        try {
            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(placeName)}&format=json&limit=1`,
                { 
                    method: 'GET',
                    headers: {
                        'User-Agent': 'LocalGuide/1.0'
                    }
                }
            );
            
            if (response.ok) {
                const data = await response.json();
                if (data && data.length > 0) {
                    const result = {
                        lat: parseFloat(data[0].lat),
                        lng: parseFloat(data[0].lon)
                    };
                    
                    // Cache the result
                    geocodeCache[placeName] = result;
                    saveCache();
                    
                    return result;
                }
            }
        } catch (fallbackError) {
            console.error('Fallback geocoding also failed:', fallbackError);
        }
    }
    return null;
}

// Calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Calculate bearing (direction) between two points
function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

// Convert bearing to compass direction
function bearingToDirection(bearing) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 
                      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(bearing / 22.5) % 16;
    return directions[index];
}

// Format distance for display
function formatDistance(km) {
    if (km < 1) {
        return `${Math.round(km * 1000)} m`;
    } else if (km < 10) {
        return `${km.toFixed(1)} km`;
    } else {
        return `${Math.round(km)} km`;
    }
}

// Parse CSV file
function parseCSV(text) {
    const lines = text.split('\n').filter(line => line.trim());
    const result = [];
    
    // Parse header to find column indices
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const titleIdx = header.indexOf('title');
    const noteIdx = header.indexOf('note');
    const urlIdx = header.indexOf('url');
    const nameIdx = header.indexOf('name');
    
    for (let i = 1; i < lines.length; i++) { // Skip header
        const line = lines[i].trim();
        if (!line || line === ',' || line === ',,,,' || line === ',,,,') continue;
        
        // Split CSV line respecting commas within quotes
        const columns = [];
        let currentCol = '';
        let inQuotes = false;
        
        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                columns.push(currentCol.trim());
                currentCol = '';
            } else {
                currentCol += char;
            }
        }
        columns.push(currentCol.trim());
        
        // Get name from appropriate column (Title, Note, or Name)
        let name = '';
        if (titleIdx >= 0 && columns[titleIdx]) {
            name = columns[titleIdx];
        }
        if (!name && noteIdx >= 0 && columns[noteIdx]) {
            name = columns[noteIdx];
        }
        if (!name && nameIdx >= 0 && columns[nameIdx]) {
            name = columns[nameIdx];
        }
        
        // Get URL
        let url = urlIdx >= 0 ? columns[urlIdx] : '';
        
        if (name && url) {
            result.push({ name, url, coords: null });
        }
    }
    
    return result;
}

// Show status message
function showStatus(message, type = 'info', autoHide = true) {
    const statusDiv = document.getElementById('statusMessage');
    statusDiv.textContent = message;
    statusDiv.className = `status-message ${type}`;
    statusDiv.style.display = 'block';
    
    if (autoHide && type !== 'info') {
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000);
    }
}

// Update the display with closest locations
function updateDisplay(closestLocations) {
    const grid = document.getElementById('locationsGrid');
    
    for (let i = 0; i < 4; i++) {
        const card = grid.children[i];
        
        if (i < closestLocations.length) {
            const loc = closestLocations[i];
            card.className = 'location-card';
            card.innerHTML = `
                <div class="location-header">
                    <div class="location-name">${loc.name}</div>
                    <div class="location-direction">
                        <div class="compass">
                            <div class="compass-arrow" style="transform: rotate(${loc.bearing}deg)"></div>
                        </div>
                        <span>📍 ${loc.direction}</span>
                    </div>
                </div>
                <div class="location-distance">${formatDistance(loc.distance)}</div>
            `;
            card.onclick = () => {
                const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${loc.coords.lat},${loc.coords.lng}`;
                window.open(directionsUrl, '_blank');
            };
        } else {
            card.className = 'location-card empty';
            card.innerHTML = '<div>No more locations</div>';
            card.onclick = null;
        }
    }
}

// Process the uploaded CSV
async function processCSV(text) {
    try {
        showStatus('Getting your location...', 'info');
        userLocation = await getUserLocation();
        
        showStatus('Parsing CSV file...', 'info');
        locations = parseCSV(text);
        
        if (locations.length === 0) {
            showStatus('No valid locations found in CSV', 'error', true);
            return;
        }

        showStatus(`Found ${locations.length} locations. Processing coordinates...`, 'info');

        // First pass: extract direct coordinates
        let geocodedCount = 0;
        let needsGeocode = [];
        
        for (let i = 0; i < locations.length; i++) {
            const loc = locations[i];
            
            // Try to extract from URL directly
            loc.coords = extractCoordinatesSync(loc.url);
            
            if (loc.coords) {
                geocodedCount++;
            } else {
                // Extract place name for later geocoding
                const placeMatch = loc.url.match(/place\/([^/]+)/);
                if (placeMatch) {
                    const placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
                    loc.placeName = placeName;
                    
                    // Check cache
                    if (geocodeCache[placeName]) {
                        loc.coords = geocodeCache[placeName];
                        geocodedCount++;
                    } else {
                        needsGeocode.push(loc);
                    }
                }
            }
        }

        showStatus(`${geocodedCount} locations have coordinates. Geocoding ${needsGeocode.length} remaining...`, 'info');

        // Second pass: geocode in parallel batches
        if (needsGeocode.length > 0) {
            const batchSize = 30; // Process 30 at a time for optimal speed
            const delayBetweenBatches = 2000; // 2 seconds between batches
            
            for (let i = 0; i < needsGeocode.length; i += batchSize) {
                const batch = needsGeocode.slice(i, i + batchSize);
                
                // Process batch in parallel
                const results = await Promise.all(
                    batch.map(loc => geocodePlaceName(loc.placeName))
                );
                
                // Assign results
                batch.forEach((loc, idx) => {
                    if (results[idx]) {
                        loc.coords = results[idx];
                        geocodedCount++;
                    }
                });
                
                showStatus(`Geocoding... ${Math.min(i + batchSize, needsGeocode.length)}/${needsGeocode.length} (${geocodedCount} total successful)`, 'info');
                
                // Delay between batches to respect rate limits
                if (i + batchSize < needsGeocode.length) {
                    await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
                }
            }
        }

        // Filter out locations without coordinates
        const validLocations = locations.filter(loc => loc.coords);

        if (validLocations.length === 0) {
            showStatus('Could not find coordinates for any locations', 'error', true);
            return;
        }

        showStatus(`Calculating distances for ${validLocations.length} locations...`, 'info');

        // Calculate distances and bearings
        validLocations.forEach(loc => {
            loc.distance = calculateDistance(
                userLocation.lat, userLocation.lng,
                loc.coords.lat, loc.coords.lng
            );
            loc.bearing = calculateBearing(
                userLocation.lat, userLocation.lng,
                loc.coords.lat, loc.coords.lng
            );
            loc.direction = bearingToDirection(loc.bearing);
        });

        // Sort by distance
        validLocations.sort((a, b) => a.distance - b.distance);

        // Get closest 4
        const closest = validLocations.slice(0, 4);
        
        updateDisplay(closest);
        showStatus(`Found ${validLocations.length} locations, showing closest 4`, 'success', true);
        
    } catch (error) {
        showStatus(`Error: ${error.message}`, 'error', true);
        console.error(error);
    }
}

// Handle file upload
document.getElementById('csvFile').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            processCSV(e.target.result);
        };
        reader.readAsText(file);
    }
});

// Load CSV from file path
async function loadCSVFile(filePath) {
    try {
        showStatus(`Loading ${filePath}...`, 'info', false);
        const response = await fetch(filePath);
        if (!response.ok) {
            throw new Error(`Failed to load ${filePath}`);
        }
        const text = await response.text();
        processCSV(text);
    } catch (error) {
        showStatus(`Error loading file: ${error.message}`, 'error', true);
        console.error(error);
    }
}

// SF button - load SF Bay Area CSV
document.getElementById('sfButton').addEventListener('click', () => {
    document.getElementById('sfButton').classList.add('active');
    document.getElementById('worldButton').classList.remove('active');
    loadCSVFile('SF Bay Area.csv');
});

// World button - load Travel Plans CSV
document.getElementById('worldButton').addEventListener('click', () => {
    document.getElementById('worldButton').classList.add('active');
    document.getElementById('sfButton').classList.remove('active');
    loadCSVFile('Travel Plans.csv');
});

// Request location permission on load
window.addEventListener('load', () => {
    loadCache(); // Load cached geocoding results
    showStatus('Click "Upload CSV File" to get started', 'info');
});
