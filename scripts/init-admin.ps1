# PowerShell script to initialize admin user
if (-not $env:ADMIN_PASSWORD) { Write-Error "Please set ADMIN_PASSWORD environment variable before running this script."; exit 1 }
if (-not (Test-Path -Path "data/users.json.template")) { Write-Error "Missing data/users.json.template"; exit 1 }
$pwd = $env:ADMIN_PASSWORD
$hash = node -e "const bcrypt=require('bcryptjs'); console.log(bcrypt.hashSync(process.env.ADMIN_PASSWORD,10));"  
if (-not $hash) { Write-Error "Failed to generate hash"; exit 1 }
Copy-Item data/users.json.template data/users.json -Force
(Get-Content data/users.json) -replace '<bcrypt-hash-placeholder>',$hash | Set-Content data/users.json
icacls data\users.json /inheritance:r > $null 2>&1
Write-Output "Admin user initialized in data/users.json (password hash set). Please remove ADMIN_PASSWORD from environment." 
