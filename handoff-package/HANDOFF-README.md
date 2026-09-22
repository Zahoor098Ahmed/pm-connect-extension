# PM Connect — Backend + Extension Handoff

Is package me 4 cheezein hain:

1. **`projex-backend.zip`** — poora website/backend code (`vendor/` aur `uploads/logs`, `uploads/reports` chhod ke, taake size chhota rahe).
2. **`projex_db_schema_only.sql`** — database ka structure (tables) — bina real data ke (developer emails/passwords jaisa sensitive data safety ki wajah se shamil nahi kiya).
3. **`pm-connect-0.1.0.vsix`** — VS Code extension ka installable build.
4. **`SETUP.md`** — poora system kaise kaam karta hai (auto-match, tracking, endpoints) — reference ke liye.

---

## Backend Chalane Ke Steps

1. XAMPP install karo (agar nahi hai): https://www.apachefriends.org
2. `projex-backend.zip` ko `C:\xampp\htdocs\projex` me extract karo.
3. XAMPP se **Apache** aur **MySQL** dono start karo.
4. phpMyAdmin (`http://localhost/phpmyadmin`) khol ke ek naya database banao: `projex_db`.
5. Usi database ko select karke `projex_db_schema_only.sql` **Import** karo (ye sirf tables banayega, khali).
6. Terminal me backend folder ke andar jao aur dependencies install karo:
   ```
   cd C:\xampp\htdocs\projex
   composer install
   ```
7. `api/config.php` check karo — `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS` sahi hain ya nahi (default XAMPP: user `root`, password khali).
8. Test karo: browser me `http://localhost/projex/index.php` kholo — admin panel dikhna chahiye.
   - Default admin login (agar naya database hai to pehle ek admin row manually add karni hogi `admins` table me — ya `database.sql` me diya gaya default use kar sakte hain agar wo bhi import karna chahein).

## Extension Chalane Ke Steps

1. VS Code kholo → Extensions panel → "..." menu → **Install from VSIX** → `pm-connect-0.1.0.vsix` select karo.
2. Koi bhi project folder open karo.
3. Extension khud background me backend se match karega (`http://localhost/projex/api/pmconnect.php` — yehi default backend URL hai, agar backend kisi aur server pe hai to VS Code settings me `pmConnect.custom.baseUrl` change karna hoga).

## Important Note

`projex_db_schema_only.sql` me **sirf tables/structure** hai, real projects/developers ka data nahi (privacy ki wajah se). Agar poora existing data (sab projects, developers, commit history) bhi chahiye, wo alag se securely share karna hoga (jaise encrypted zip ya direct DB-to-DB copy) — text/chat ke zariye nahi bhejna chahiye kyunke ismein password hashes aur emails hain.
