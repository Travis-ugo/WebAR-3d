// ============================================================================
// 1. CORE NODE.JS MODULE IMPORTS
// ============================================================================
/*
  May, Node.js comes packaged with built-in helper toolkits called modules.
  We import them here to handle files, network sockets, and directories:
*/
const https = require('https');   // Handles secure encrypted HTTPS socket connections
const http = require('http');     // Handles standard unsecured HTTP socket connections
const fs = require('fs');         // File System: allows us to read/write files from the laptop disk
const path = require('path');     // Handles system-independent file directory path resolutions
const os = require('os');         // Operating System: queries computer details (like network IPs)
const { execSync } = require('child_process'); // Runs native terminal commands directly from our script

// ============================================================================
// 2. THIRD-PARTY MODULE IMPORTS (NPM DEPENDENCIES)
// ============================================================================
/*
  These are libraries installed via package.json.
  We use them to generate QR codes inside the developer command terminal and images.
*/
const qrcodeTerminal = require('qrcode-terminal'); // Prints black-and-white QR codes directly into shell logs
const QRCode = require('qrcode');                  // Generates high-res QR code image files (.png)

// ============================================================================
// 3. SERVER PORT CONFIGURATION
// ============================================================================
const PORT_HTTPS = 3030; // Secure camera port: mobile phones require HTTPS to allow camera access
const PORT_HTTP = 8080;  // Regular preview port: use this for local testing on your laptop browser

// Paths where SSL certificates will be saved
const keyPath = path.join(__dirname, 'key.pem');   // Private encryption key
const certPath = path.join(__dirname, 'cert.pem'); // Public digital certificate file

// ============================================================================
// 4. SSL CERTIFICATE GENERATOR (HTTPS BINDING SECURITY)
// ============================================================================
/*
  May, modern smartphone browsers (Safari, Chrome) enforce a strict security rule:
  "Websites cannot open the user's camera unless they are loaded over a secure HTTPS line."
  
  To allow testing locally without buying a commercial web domain, we generate a 
  "Self-Signed SSL Certificate" right here. This certificates encrypts the data 
  exchanged between your laptop and your phone.
  
  This function checks if the certificate files exist. If not, it executes the
  'openssl' program on your terminal to create key.pem and cert.pem files.
*/
function checkAndGenerateCertificates() {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return; // Certificates already exist, skip generation
  }

  console.log('🔑 Generating self-signed SSL certificates for secure HTTPS testing...');
  try {
    // Run terminal command to generate credentials natively using OpenSSL
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -sha256 -days 365 -nodes -subj "/CN=localhost"`,
      { stdio: 'inherit' }
    );
    console.log('Certificates generated successfully (key.pem, cert.pem).\n');
  } catch (error) {
    console.error('Failed to generate SSL certificates natively. Please check if openssl is installed.', error);
    process.exit(1); // Exit program with error
  }
}

// Ensure certificates are generated before booting servers
checkAndGenerateCertificates();

// ============================================================================
// 5. LOCAL IP NETWORK RESOLUTION (MOBILE CONNECTIVITY)
// ============================================================================
/*
  To test on your smartphone, your phone and your laptop must be connected to the 
  same Wi-Fi router. We inspect the computer's network interface cards to resolve 
  your laptop's local IP address (e.g. 192.168.1.168).
  This tells your phone exactly where to request the files.
*/
function getLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name in interfaces) {
    for (const netInterface of interfaces[name]) {
      // Filter out internal localhost addresses (127.0.0.1) and only extract IPv4
      if (netInterface.family === 'IPv4' && !netInterface.internal) {
        addresses.push(netInterface.address);
      }
    }
  }
  return addresses;
}

const localIPs = getLocalIPAddresses();

// ============================================================================
// 6. MIME TYPES MAP (TELLING THE BROWSER WHAT FILE IS WHAT)
// ============================================================================
/*
  When a browser requests a file, it relies on the "Content-Type" header to know
  whether it is reading HTML layout, Javascript scripts, CSS styles, or a 3D model.
  This dictionary maps file extensions to their official MIME identifiers.
*/
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mind': 'application/octet-stream', // Compiled computer-vision tracking descriptor targets file
  '.gltf': 'model/gltf+json',          // JSON-based 3D model descriptor format
  '.glb': 'model/gltf-binary'          // Binary compiled 3D model format
};

// ============================================================================
// 7. MAIN ROUTING REQUEST HANDLER
// ============================================================================
/*
  This function triggers every single time a browser requests a URL.
  It reads the requested path, checks security permissions, and pipes the 
  corresponding file data back to the browser.
*/
function handleRequest(req, res) {
  // Strip query parameters (like index.html?autostart=true) to isolate raw file paths
  const urlPath = req.url.split('?')[0];
  const decodedUrl = decodeURI(urlPath);
  
  // Custom Routing Dispatch: map URLs to local disk files
  let filePath;
  if (decodedUrl === '/' || decodedUrl === '') {
    filePath = path.join(__dirname, 'index.html'); // Default home route
  } else if (decodedUrl === '/preview') {
    filePath = path.join(__dirname, 'preview.html'); // Preview sandbox page
  } else {
    filePath = path.join(__dirname, decodedUrl); // Relative assets paths
  }
  
  // Security Guard against Directory Traversal attacks:
  // Prevents malicious URL inputs (like ../../etc/passwd) from escaping our root folder.
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  // If path is a folder, resolve to index.html internally
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // File Not Found (404) fallback
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // ==========================================================================
  // HTTP RANGE REQUESTS SYSTEM (IOS COMPATIBILITY PATCH)
  // ==========================================================================
  /*
    May, this is a massive gotcha!
    Safari on iPhones and iPads refuses to play media assets (like audio waves or video clips) 
    unless the server supports "Range Requests". 
    Instead of asking for the whole file at once, iOS asks for small chunks (e.g. "bytes 0-100").
    If the server does not support this and sends back 200 OK with the entire file, 
    iOS simply displays a broken media player and refuses to play anything.
    
    This block intercepts requests containing `headers.range` for MP4/MP3 media files,
    reads only the specific range slices requested, and responds with a HTTP status code:
    `206 Partial Content`, ensuring seamless playback on mobile Safari.
  */
  if (contentType === 'video/mp4' && req.headers.range) {
    const range = req.headers.range;
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Range checks
    if (start >= fileSize || end >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };
    
    res.writeHead(206, head);
    file.pipe(res); // Streams chunk stream directly to browser
  } else {
    // Standard File Serving pipeline (200 OK)
    const isCacheableAsset = /\.(glb|gltf|mind|png|jpg|jpeg|webp)$/i.test(filePath);
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };

    // Performance Optimization: Cache heavy 3D GLTF models and tracker descriptors 
    // inside the browser's disk cache for 24 hours. This cuts load times drastically on mobile.
    if (isCacheableAsset) {
      head['Cache-Control'] = 'public, max-age=86400';
    }
    
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
}

// ============================================================================
// 8. LAUNCH SERVERS
// ============================================================================

// A. SECURE HTTPS SERVER (MOBILE TESTING)
const sslOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
};

const httpsServer = https.createServer(sslOptions, handleRequest);
httpsServer.listen(PORT_HTTPS, () => {
  console.log('==================================================');
  console.log(`🔒 Secure HTTPS Server (Mobile Testing) running:`);
  console.log(`   On Laptop:  https://localhost:${PORT_HTTPS}`);
  
  // Render and export connection details for each network IP address
  localIPs.forEach(ip => {
    const mobileUrl = `https://${ip}:${PORT_HTTPS}`;
    console.log(`   On Mobile:  ${mobileUrl}`);
    console.log(`   Scan the QR code below to open this URL directly on your phone:`);
    
    // Generate terminal-friendly visual QR code
    qrcodeTerminal.generate(mobileUrl, { small: true });

    // Save visual PNG QR Code image file for student reference
    const qrImagePath = path.join(__dirname, 'qrcode.png');
    QRCode.toFile(qrImagePath, mobileUrl, {
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 512
    }, (err) => {
      if (err) {
        console.error('   [ERROR] Failed to save QR code picture:', err);
      } else {
        console.log(`   [SUCCESS] QR Code picture generated and saved to: ${qrImagePath}`);
      }
    });
  });
  console.log('==================================================');
  console.log('💡 Note: When loading on your smartphone, you will see a certificate warning.');
  console.log('   Simply tap "Advanced" -> "Proceed anyway" to bypass it.');
  console.log('   (Self-signed certificate is completely safe for local development)');
  console.log('==================================================\n');
});

// B. NON-SECURE HTTP SERVER (LAPTOP PREVIEWS)
const httpServer = http.createServer(handleRequest);
httpServer.listen(PORT_HTTP, () => {
  console.log(`🔌 HTTP Preview Server running at http://localhost:${PORT_HTTP}\n`);
});
