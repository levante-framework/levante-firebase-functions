#!/bin/bash

# Validate Firestore indexes against dev project
# Usage: ./scripts/validate-indexes.sh

set -e

echo "🔍 Validating Firestore indexes..."

# Check if firebase CLI is installed
if ! command -v firebase &> /dev/null; then
    echo "❌ Firebase CLI is not installed. Please install it first:"
    echo "npm install -g firebase-tools"
    exit 1
fi

# Check if we're in the right directory
if [ ! -f "firestore.indexes.json" ]; then
    echo "❌ firestore.indexes.json not found. Please run this script from the functions/levante-admin directory."
    exit 1
fi

# Export current indexes from dev
echo "📥 Exporting current indexes from dev project..."
firebase firestore:indexes --project dev > current-indexes.json

# Function to normalize JSON for comparison
normalize_json() {
    jq -S '.' "$1" | sed 's/[[:space:]]//g'
}

# Normalize both files
normalize_json "firestore.indexes.json" > local-normalized.json
normalize_json "current-indexes.json" > remote-normalized.json

# Compare the normalized files
if cmp -s local-normalized.json remote-normalized.json; then
    echo "✅ Firestore indexes match! Local file is up to date with dev project."
    rm -f current-indexes.json local-normalized.json remote-normalized.json
    exit 0
else
    echo "❌ Firestore indexes do not match!"
    echo ""
    echo "Differences found:"
    echo "=================="
    diff local-normalized.json remote-normalized.json || true
    echo ""
    echo "To fix this:"
    echo "1. Run: firebase firestore:indexes --project dev > firestore.indexes.json"
    echo "2. Review the changes"
    echo "3. Commit the updated firestore.indexes.json file"
    
    # Cleanup
    rm -f current-indexes.json local-normalized.json remote-normalized.json
    exit 1
fi 