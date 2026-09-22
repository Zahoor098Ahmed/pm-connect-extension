# PM Connect (VS Code Extension) — Roman Urdu Mukammal Guide

Yeh document **PM Connect** VS Code extension ke architecture, working flow, background tracking, aur backend integration ki aasan Roman Urdu mein mukammal tafseel faraham karta hai.

---

## 1. PM Connect Kya Hai? (Overview)

**PM Connect** ek aisi smart VS Code extension hai jo developer ke editor ko seedha Project Management tool (jaise company ka apna **Projex / Custom REST API** ya **Trello**) ke sath connect karti hai.

### Iska Asal Faida:
- **Zero Manual Interaction:** Developer ko na to manual timer start karne ki zaroorat hai, aur na hi baith kar reports type karni hain.
- **Silent Background Tracking:** Extension khud detect karti hai ke project kab shuru hua, kon kon se Git commits hue, aur developer ne kitni der active coding ki.
- **Data Privacy & Security:** API keys aur tokens kabhi bhi plain text settings mein save nahi hote, balki VS Code ke secure `SecretStorage` mein rehte hain.

---

## 2. Yeh Kese Kaam Karta Hai? (Architecture & Lifecycle)

Jab aap VS Code mein koi bhi project folder open karte hain, to PM Connect ka lifecycle is tarah chalta hai:

```
                  VS Code Window Open
                           │
                           ▼
              ┌──────────────────────────┐
              │  1. Silent Auto-Matching  │
              │  (Git Email, URL, User)  │
              └──────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
      [Match Ho Gaya]             [Naya Project]
             │                           │
  Auto Link Project & API Key    Auto-Create on Backend
             │                           │
             └─────────────┬─────────────┘
                           │
                           ▼
              ┌──────────────────────────┐
              │  2. Start Tracking       │
              ├──────────────────────────┤
              │ • Project Start Ping     │
              │ • Git Commit Tracker     │
              │ • Active Coding Time     │
              └──────────────────────────┘
                           │
                           ▼
              ┌──────────────────────────┐
              │  3. UI & Sidebars Update │
              │ • Status Bar             │
              │ • "My Tasks" Panel       │
              │ • "Reports" Panel        │
              └──────────────────────────┘
```

---

## 3. Silent Auto-Matching (Zero-Configuration Setup)

Aapko har dafa project ID ya settings configure karne ki zaroorat nahi hoti:

1. **Information Collect:**
   - Extension aapke local workspace se:
     - Git Email (`git config user.email`)
     - Git Remote URL (`git config --get remote.origin.url`)
     - Machine / OS Username (e.g. `Ali Akber`)
     - Folder ka naam (e.g. `pm-connect-extension`)
2. **Backend Handshake:**
   - Yeh data backend ke `POST /projects/auto-match` endpoint par bhejti hai.
3. **Automatic Linking:**
   - Agar backend par is Git URL ya email par project pehle se assign hai, to extension ko `apiKey` aur `projectId` wapas mil jata hai.
   - Extension chup-chaap ise local workspace se link kar deti hai aur tracking shuru ho jati hai.
4. **Silent Behaviour:**
   - Agar project match na ho, to koi bekar error popup nahi aata. Developer sakoon se coding karta rehta hai.

---

## 4. Background Automatic Tracking (Asal Engine)

Yeh extension 3 qisam ke signals background mein khud track karti hai:

### A. Project Started Signal (`projects/start`)
- Jab kisi linked project par pehli dafa kaam shuru hota hai, to backend par ek idempotent (safe) ping jata hai ke developer ne is project par kaam shuru kar diya hai. Backend par project ka status "In Progress" aur start time record ho jata hai.

### B. Git Commit Tracking (`commitTracker.js`)
- **Real-time Hook:** VS Code ki built-in Git extension ke events ko listen karti hai. Jaise hi developer commit karta hai, usi lamhe detect ho jata hai.
- **5-Minute Fallback Polling:** Agar developer terminal se `git commit` kare ya VS Code Git extension slow ho, to har 5 minute baad fallback check chalta hai.
- **Data Sent:** Commit SHA hash, commit message, aur change hone wali files ki list backend ke `POST /commits` par save hoti hai.
- **Monorepo Support:** Agar `.git` root folder mein na ho balki kisi subfolder (jaise `frontend/`) mein ho, to ye usko bhi auto-detect kar leta hai.

### C. Active Coding Time Tracking (`activityTracker.js`)
- **Kaise count karta hai?**
  - Window focus (VS Code open hai ya minimize).
  - Code edits, typing, aur cursor movement.
- **Sampling & Flush:**
  - Har **30 seconds** mein sample karta hai.
  - Har **60 seconds** baad jama shuda active seconds ko backend ke `POST /activity/heartbeat` par bhejta hai.
- **Idle Timeout (Default: 5 Minutes):**
  - Agar developer screen chorr kar chala jaye aur 5 minute tak koi keypress ya mouse click na ho, to tracking pause ho jati hai taake fake hours count na hon.

---

## 5. Providers System (Custom API & Trello)

Extension modular architecture par bani hai (`src/providers/`):

### 1. Custom Provider (`customProvider.js`):
- Company ke apne portal ya website (jaise Projex PHP backend) ke liye.
- Endpoints:
  - `POST /projects/auto-match`
  - `POST /projects/auto-create`
  - `POST /projects/start`
  - `POST /commits`
  - `POST /activity/heartbeat`
  - `GET /tasks/mine`
  - `GET /reports/rollup`
- `X-API-Key` aur `X-Project-Id` headers ke zariye har request authenticate aur scope hoti hai.

### 2. Trello Provider (`trelloProvider.js`):
- Agar team Trello use kar rahi ho:
  - Trello API Key aur Token ke zariye connect hota hai.
  - Board ID aur List ID se cards utha kar VS Code mein tasks banata hai.
  - Task status update karne par Trello card doosri list mein move ho jata hai.

---

## 6. UI Components (Aapko Screen Par Kya Dikhai Deta Hai)

1. **Activity Bar Icon (`resources/icon.svg`):**
   - Left side panel par PM Connect ka icon aata hai jisme do views hain:
     - **My Tasks:** Aapke assign shuda tasks ki tree list. Aap yahan se status (Pending, In Progress, Completed) change kar sakte hain.
     - **Reports:** Pichle 30 din ka data, kitne commits hue, kitne ghante kaam hua, aur project kab shuru hua. Har 2 minute baad auto-refresh hota hai.
2. **Status Bar (`statusBar.js`):**
   - VS Code ke bottom footer bar mein chota status icon:
     - `$(check) PM Connect` = Connected & Tracking
     - `$(sync~spin) PM Connect` = Syncing data
     - `$(warning) PM Connect` = Disconnected ya attention required
3. **Team Sharing (`pmconnect.config.json`):**
   - Setup ke baad extension poochti hai ke kya ye settings team ke liye save karni hain?
   - Is se `pmconnect.config.json` ban jati hai (bina passwords/keys ke), jise git mein commit kar diya jaye to baqi developers ko sirf apni API key daalni parti hai.

---

## 7. VS Code Commands (Command Palette: `Ctrl + Shift + P`)

| Command | Kya Karti Hai? |
| :--- | :--- |
| `PM Connect: Create Task` | Active editor mein select shuda code se seedha naya task create karti hai. |
| `PM Connect: Sync Project` | Current file ya workspace ko backend ke sath sync karti hai. |
| `PM Connect: Refresh My Tasks` | Tasks ki list dobara fetch karti hai. |
| `PM Connect: Update Task Status` | Task ka status change karti hai (Pending / Progress / Done). |
| `PM Connect: Switch Provider` | Custom backend aur Trello ke darmiyan switch karne ke liye. |
| `PM Connect: Refresh Reports` | Reports side panel ko foran refresh karti hai. |
| `PM Connect: Open Settings` | Extension ki configurations open karti hai. |
| `PM Connect: Add GitHub Comment` | GitHub issue par directly editor se comment post aur verify karti hai. |

---

## 8. Settings Guide (`settings.json`)

`Ctrl + ,` daba kar `pmConnect` search karein:

- `pmConnect.provider`: Active provider (`custom` ya `trello`).
- `pmConnect.custom.baseUrl`: Backend API ka base address (e.g. `http://localhost/projex/api/pmconnect.php`).
- `pmConnect.custom.siteUrl`: Projex web dashboard ka link (reports view ke liye).
- `pmConnect.custom.projectId`: Current workspace ka project ID (Auto-match khud set karta hai).
- `pmConnect.activity.idleThresholdMinutes`: Idle time limit (Default: 5 minutes).

---

## 9. Troubleshooting (Agar Koi Masla Aaye)

1. **Extension icon nazar nahi aa raha:**
   - Install ya update ke baad VS Code ko mukammal restart karein (`Ctrl+Shift+P` -> `Developer: Reload Window`).
2. **"Cannot find module 'node-fetch'":**
   - Jab `.vsix` build kiya jaye to `node_modules` package mein shamil hona lazmi hai (`.vscodeignore` check karein).
3. **Tracking ka status dekhna ho:**
   - VS Code menu: `View -> Output` -> dropdown mein **"PM Connect"** select karein. Wahan background ke saare pings aur logs live nazar aate hain.
