#!/bin/sh
# Usage: ADMIN_PASSWORD=yourpass sh ./scripts/init-admin.sh
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "Please set ADMIN_PASSWORD environment variable before running this script."
  exit 1
fi
if [ ! -f data/users.json.template ]; then
  echo "Missing data/users.json.template"
  exit 1
fi
# Generate bcrypt hash using node
HASH=$(node -e "const bcrypt=require('bcryptjs'); bcrypt.hashSync(process.env.ADMIN_PASSWORD,10);" )
if [ -z "$HASH" ]; then
  echo "Failed to generate hash"
  exit 1
fi
cp data/users.json.template data/users.json
# replace placeholder with actual hash
perl -0777 -pe "s/<bcrypt-hash-placeholder>/${HASH}/gms" -i data/users.json
chmod 600 data/users.json
echo "Admin user initialized in data/users.json (password hash set). Please remove ADMIN_PASSWORD from environment." 
