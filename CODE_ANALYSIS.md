# PM Connect Extension — Deep Code Analysis

Ye file batati hai ke extension ka code **abhi kya kya karta hai**, kaise kaam karta hai, aur **kya masle (bugs)** abhi is me maujood hain.

---

## 1. Poora System Ek Nazar Me

```
VS Code khulta hai
   │
   ├─▶ tryAutoMatch()       → developer + project ko backend se silently match karta hai
   ├─▶ autoCreateProjectIfNeeded() → agar match na mile to naya project auto-bana deta hai
   └─▶ startTracking()      → background tracking shuru:
          ├─ commitTracker.js   → har git commit ko backend ko bhejta hai
          └─ activityTracker.js → har 30s me "active coding time" measure karta hai

           ↓ (agar backend down ho)
      offlineQueue.js  → data local disk pe queue ho jata hai
      syncManager.js   → har 5 min me retry karke queue empty karta hai

           ↓ (hamesha, chahe backend up ho ya down)
      activityLog.js / activityLogStore.js / dailySummaryTracker.js
         → sab kuch local JSON files me bhi save hota hai (backup + UI ke liye)
```

---

## 2. File-by-File — Kya Karta Hai

### `extension.js` (Entry Point)
- Extension activate hone par sab modules initialize karta hai (`offlineQueue`, `dailySummaryTracker`, `activityLog`, `activityLogStore`, `syncManager`).
- **Commands** register karta hai (Command Palette + status bar menu se accessible):
  - `pmConnect.connect` — manual connect (agar auto-match fail ho)
  - `pmConnect.disconnect` — tracking rok deta hai, API key clear karta hai
  - `pmConnect.viewPendingQueue` — offline queue me kya pending hai dikhata hai
  - `pmConnect.viewChangedPages` — aaj kaunse files edit hui, list dikhata hai
  - `pmConnect.viewAllComments` — saare commits + daily logs ek report me
  - `pmConnect.addGitHubComment` — **⚠️ TOOTA HUA HAI** (neeche dekhein, Section 4)
  - `pmConnect.refreshReports`, `pmConnect.openReport`, `pmConnect.switchProvider`, waghera
- `init()` function: activation pe automatically `tryAutoMatch()` → first-time setup (agar zaroorat ho) → `autoCreateProjectIfNeeded()` → `startTracking()` chalata hai — **koi manual step developer se nahi maanga jata**.

### `commitTracker.js` (Commit Detection)
- VS Code ke built-in Git extension API se sunta hai: jab bhi commit ho, turant detect karta hai. Iske sath ek **5-minute fallback poll** bhi chalta hai (agar terminal se commit ho ya Git API available na ho).
- Har naye commit par:
  1. Changed files nikaalta hai (`git diff`).
  2. `activityLog.recordCommit()` se local JSON me save karta hai.
  3. Backend ko `logCommitHeartbeat` bhejta hai.
  4. `logActivityEntry` se bhi backend ko notify karta hai.
  5. **VS Code notification dikhata hai**: "Aapka code comment project management me add hogya he!" — chahe success ho ya fail ho (dono jagah yehi message hai — dekhein Section 4).

### `activityTracker.js` (Active Time Tracking)
- Har 30 second me check karta hai: VS Code window focused hai? Recent typing/selection hui hai (5 min ke andar)? Agar haan → "active" second count hota hai.
- Har 60 second me buffer ko backend ko flush karta hai (`logActiveHeartbeat`).
- Har active session (jab tak 5 min idle na ho jaye) ko `activityLog.recordSession()` se local record karta hai — start time, end time, files touched.
- Idle detection: agar 5 minute tak koi activity nahi, session "finalize" ho jata hai.

### `offlineQueue.js` (Backend Down Hone Par Safety Net)
- Agar koi bhi backend call fail ho (network down, server down), wo data **disk pe JSON file** me queue ho jata hai (`pending-logs.json`), delete nahi hota.
- Max 2000 entries — usse zyada ho to purani entries `overflow-logs.json` me move ho jati hain.
- Har entry 10 baar tak retry hoti hai; usse zyada fail ho to `failed-logs.json` me permanently move ho jati hai (queue block nahi hoti).
- **Atomic writes** use karta hai (pehle temp file, phir rename) — taake crash hone par file corrupt na ho.

### `syncManager.js` (Queue Ko Wapas Bhejna)
- Har 5 minute me background me chalta hai: pehle backend "reachable" hai ya nahi check karta hai (health check), phir queue ko FIFO order me sync karta hai.
- Agar sync ho jaye to VS Code notification: "✅ PM Connect: N logs synced successfully."
- Sab activity ek **Output Channel** ("PM Connect") me bhi log hoti hai — debugging ke liye.

### `activityLog.js` + `activityLogStore.js` + `dailySummaryTracker.js` (Local Data Storage)
- **`activityLog.js`**: har commit aur coding-session ka permanent record (`activity-log.json`, max 5000 entries) — "kis din kya hua" ka poora history.
- **`dailySummaryTracker.js`**: din-wise, project-wise total active minutes (`daily-summary.json`).
- **`activityLogStore.js`**: sidebar UI ke liye chhota recent-activity feed (`activity-history.json`, max 100 entries) — status bar aur sidebar tree view isi se render hote hain.
- Teeno alag-alag files hain, thoda overlap hai (dono `activityLog` aur `dailySummaryTracker` "aaj kitne minutes" calculate karte hain) — neeche Section 4 me discuss kiya hai.

### `customProvider.js` (Backend Se Baat Karne Wala Layer)
- Saare backend calls (`logCommitHeartbeat`, `logActiveHeartbeat`, `logDailySummary`, `logActivityEntry`, `markProjectStarted`, `automatch`, `autocreateproject`, `getRollup`, `getMyRollups`) yahin se hote hain.
- Har call `sendLogWithQueueFallback()` se guzarta hai — agar backend fail ho to automatically `offlineQueue` me daal deta hai, exception developer ko kabhi nahi dikhti.

### `gitProgress.js`
- Raw `git` shell commands wrap karta hai: current commit SHA, naye commits ki list, ek commit me kaunse files change hui.

### `reportsTreeView.js`, `tasksTreeView.js`, `activityLogsTreeView.js`, `statusBar.js`
- VS Code sidebar/status-bar UI — koi business logic nahi, sirf data ko render karte hain.

---

## 3. Zero-Interaction Flow (Poori Kahani, Step-by-Step)

1. Developer VS Code kholta hai, project folder open karta hai.
2. `tryAutoMatch()` silently git email + repo URL + machine username backend ko bhejta hai.
3. Backend match karta hai (developer `users` table se, project `repo_url`/naam se) — API key + project ID wapas aati hai, extension settings me save ho jati hai.
4. Match na mile to `autoCreateProjectIfNeeded()` naya project bana deta hai (folder ke naam se).
5. `startTracking()` shuru: commit tracker + activity tracker background me chalte rehte hain.
6. Har commit/active-time backend ko jaata hai — agar backend down ho to local queue me park ho jata hai, har 5 min retry hota hai.
7. Developer ko koi manual step nahi karna — sirf VS Code me chhoti notifications dikhti hain.

---

## 4. Masle / Bugs Jo Mujhe Mile (Important)

### 🔴 Critical — `pmConnect.addGitHubComment` command crash karega
`extension.js` (line ~758) me `getLatestOpenIssue`, `postComment`, aur `fetchRecentComments` functions **call** hote hain, lekin **kahin define/import nahi hain** — na `extension.js` me, na kisi aur file me. Jab bhi koi is command ko chalayega, ye turant crash ho ke error dega ("...is not defined"). **Ye feature abhi bilkul kaam nahi karta.**

### 🟡 Confusing notification message
`commitTracker.js` me commit ke baad **hamesha** ye message dikhta hai: *"Aapka code comment project management me add hogya he!"* — chahe backend call **successful** ho ya **fail** ho jaye (dono `try` aur `catch` block me same message hai, line 105 aur 109). Matlab agar backend down bhi ho, developer ko yehi lagega ke sab theek se chala gaya — jabke asal me data sirf offline queue me park hua hota hai.

### 🟡 Teen jagah "aaj kitna time active raha" calculate hota hai
- `activityLog.getTodayMinutesFromLog()`
- `dailySummaryTracker.getTodayMinutes()` (jo internally upar wale ko bhi call karta hai aur `Math.max` leta hai)
- `activityLogStore` ka apna alag recent-feed

Teeno alag JSON files me overlapping data rakhte hain. Kaam karta hai, lekin thoda redundant hai — future me inko ek single source of truth me merge kiya ja sakta hai.

### 🟢 Achhi cheezein (jo sahi design hain)
- Har jagah **atomic file writes** (temp file → rename) — crash-safe.
- Offline queue **FIFO + max-retry + overflow protection** — data kabhi permanently silently lost nahi hota.
- Har backend call `sendLogWithQueueFallback` se guzarta hai — koi bhi network failure developer ko crash/error dialog nahi dikhati (zero-interaction promise maintained).
- Commit tracking dono **event-based** (turant) aur **poll-based** (5-min fallback) hai — Git extension unavailable ho tab bhi kaam karta hai.

---

## 5. Recommendation (Agar Aage Fix Karna Ho)

1. **Pehle** `addGitHubComment` — ya to `getLatestOpenIssue`/`postComment`/`fetchRecentComments` implement karo (GitHub REST API se), ya command hi hata do agar zaroorat nahi.
2. Commit-notification message ko success/fail ke hisaab se alag karo — jaisa pehle tha (`✅ Progress updated` on success, kuch bhi na dikhao ya `⏳ Queued (backend unreachable)` on fail).
3. `activityLog` aur `dailySummaryTracker` ko consolidate karne pe soch sakte hain — abhi dono chal rahe hain isliye functionally break nahi hai, sirf duplicate storage hai.
