const fs = require('fs');
const path = require('path');

/**
 * Atomically writes JSON data to disk using write-temp-then-rename with Windows
 * transient lock tolerance (prevents data corruption or UNKNOWN lock errors).
 */
function writeJsonAtomicSync(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const payload = JSON.stringify(data, null, 2);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;

    try {
        fs.writeFileSync(tmpPath, payload, 'utf8');

        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                fs.renameSync(tmpPath, filePath);
                return;
            } catch (err) {
                lastErr = err;
                // Brief spin-wait for transient Windows Defender / indexer handles
                const waitUntil = Date.now() + 15 * (attempt + 1);
                while (Date.now() < waitUntil) {}
            }
        }

        // Fallback direct overwrite if rename remains blocked across retries
        fs.writeFileSync(filePath, payload, 'utf8');
        if (lastErr && fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }
    } finally {
        if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }
    }
}

module.exports = {
    writeJsonAtomicSync
};
