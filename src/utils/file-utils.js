const path = require('path');
const fs = require('fs');
const { IGNORE_LIST, ALLOWED_EXTENSIONS } = require('./config');

function checkIgnoreStatus(filePath) {
    const fileName = path.basename(filePath);
    const fileExtension = path.extname(filePath).toLowerCase();

    // Check if the file or folder is in the ignore list
    if (IGNORE_LIST.some(ignoreItem => {
        if (ignoreItem.startsWith('*')) {
            return fileName.endsWith(ignoreItem.slice(1));
        }
        return fileName === ignoreItem;
    })) {
        return { ignored: true, reason: 'ignore_list' };
    }

    // If it's a directory, don't ignore it based on extension
    if (fs.statSync(filePath).isDirectory()) {
        return { ignored: false };
    }

    // Check if the file extension is in the allowed list
    if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
        return { ignored: true, reason: 'extension' };
    }

    return { ignored: false };
}

// Keep the original shouldIgnore for backward compatibility
function shouldIgnore(filePath) {
    return checkIgnoreStatus(filePath).ignored;
}

function isSubPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mergeItems(existingItems, newItems) {
    const mergedItems = [...existingItems];

    newItems.forEach(newItem => {
        const existingIndex = mergedItems.findIndex(item => item.path === newItem.path);

        if (existingIndex !== -1) {
            return;
        }

        const parentIndex = mergedItems.findIndex(item =>
            item.isDirectory && isSubPath(item.path, newItem.path)
        );

        if (parentIndex !== -1) {
            if (!mergedItems[parentIndex].children) {
                mergedItems[parentIndex].children = [];
            }
            mergedItems[parentIndex].children.push(newItem);
        } else {
            mergedItems.push(newItem);
        }
    });

    return mergedItems;
}

module.exports = {
    shouldIgnore,
    checkIgnoreStatus,
    mergeItems
};