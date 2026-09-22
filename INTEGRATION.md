# PM Connect — Website Integration Guide (For Customers)

Yeh document apne developer/backend team ko do. Isme likha hai ki agar aap chahte ho ke
**PM Connect extension** sirf aapki website ka **link + API key** daal ke turant connect ho jaye
(koi extra settings/path-override configure kiye bina), toh aapki website ke backend ko
**exactly** yeh 5 endpoints implement karne honge, isi shape mein.

> Yeh **standard contract** hai — agar aap in exact paths/methods/JSON shapes ko follow karte ho,
> PM Connect Marketplace se install karne wala koi bhi user sirf apni website ka URL + personal
> API key daal ke turant connect ho jayega. Kuch bhi extra configure nahi karna padega.

---

## Zaroori: Authentication

Har request mein yeh 2 headers aayenge:

| Header | Kya hai |
|---|---|
| `Authorization: Bearer <api_key>` | User ki personal API key — aapke system mein kaunsa user hai, isse pehchano |
| `X-Project-Id: <project_id>` | Kaunsa project/workspace — is value ko apni marzi se define karo (numeric ID, slug, kuch bhi) |

Aapke backend ko:
1. `api_key` se user ko match karna hai (401 return karo agar galat/missing ho)
2. `X-Project-Id` se data filter karna hai (sirf usi project ke tasks return/update karo)

---

## 5 Endpoints (yeh exact paths, methods, aur JSON shapes chahiye)

### 1. `GET /tasks/mine`
User ke current project ke saare tasks return karo.

**Response `200`:**
```json
[
  { "id": "1", "title": "Fix login bug", "status": "open", "description": "...", "progress": 0 },
  { "id": "2", "title": "Write docs", "status": "in-progress", "description": "...", "progress": 40 }
]
```

### 2. `POST /tasks`
Naya task banao.

**Request body:**
```json
{ "title": "New task", "description": "optional" }
```

**Response `201`:**
```json
{ "id": "3", "title": "New task", "status": "open" }
```

### 3. `PATCH /tasks/{id}/status`
Task ka status badlo.

**Request body:**
```json
{ "status": "done" }
```

**Response `200`:**
```json
{ "id": "3", "status": "done" }
```

### 4. `PATCH /tasks/{id}/progress`
Commit-count se calculate hua % complete save karo (extension yeh khud bhejta hai, developer manually nahi).

**Request body:**
```json
{ "percentage": 60, "commitsDone": 3, "commitsTotal": 5, "commitMessage": "fix login flow" }
```

**Response `200`:**
```json
{ "id": "3", "progress": 60 }
```

### 5. `PATCH /tasks/{id}/timelog`
Timer se actual minutes save karo (yeh asli timesheet data hai).

**Request body:**
```json
{ "minutes": 30, "note": "optional note" }
```

**Response `200`:**
```json
{ "id": "3", "totalMinutes": 45 }
```
`totalMinutes` **accumulate** hona chahiye (naye minutes purane mein add), replace nahi.

---

## Optional: `GET /admin/employees`

Agar admin panel mein "kis employee ne kitna kaam kiya" dikhana hai:

**Response `200`:**
```json
{
  "success": true,
  "employees": [
    { "name": "Ali", "totalMinutes": 120, "tasksTouched": 4 },
    { "name": "Ayesha", "totalMinutes": 80, "tasksTouched": 2 }
  ]
}
```

---

## Customer Setup (zero-config, agar upar wala contract follow kiya)

Customer ka developer VS Code mein extension install karega, phir:

1. `Ctrl+Shift+P` → **"PM Connect: Switch Provider"** → **"Custom / Our Website"**
2. **Base URL**: `https://customer-ki-website.com/api` (jahan bhi yeh 5 endpoints hosted hain)
3. **API Key**: apne backend se generate ki hui personal key
4. **Project ID**: apna project identifier

**Bas itna hi — koi path-override, koi extra config nahi.** Kyunki extension ke default paths
(`/tasks`, `/tasks/mine`, `/tasks/{id}/status`, etc.) already isi contract se match karte hain.

---

## Agar aapki website is exact contract ko follow **nahi** karti (jaisa humari apni Projex website)

Tab bhi connect ho sakta hai, lekin ek extra step lagega — VS Code Settings mein
`pmConnect.custom.paths` override karke apni website ke actual endpoint paths batane honge
(README.md mein "Settings" section dekho). Yeh sirf tab chahiye jab aap **is exact spec ko follow
na karo** — naya REST backend banate waqt seedha yeh contract follow karna sabse aasan hai.

---

## Optional: Auto-Matching Handshake (`POST /projects/auto-match`)

Agar aap chahte hain ke aapke developers ko manual settings na karni paden, toh aap **Auto-Matching** support kar sakte hain. Jab developer project folder open karega, extension unke Git user email aur remote URL ko auto-detect karke is endpoint pe bhejega:

**Request body:**
```json
{
  "gitEmail": "developer@example.com",
  "machineUsername": "devname",
  "workspaceFolderName": "my-project-folder",
  "gitRemoteUrl": "git@github.com:org/repo.git"
}
```

**Response `200`:**
```json
{
  "success": true,
  "apiKey": "developer_personal_api_key",
  "projectId": "project_id"
}
```
Agar dono match ho jayein toh API key aur project ID return kar dein, extension isko silently background mein link kar ke connect ho jayega.

---

## Jira / Trello Users Ke Liye

In users ko **kuch bhi banana nahi hai** — woh apne Jira/Trello account se seedha connect hote
hain (extension unke API ko directly use karta hai). Yeh sirf "Custom / Our Website" provider ke
liye hai — jab customer apna khud ka backend use kar raha ho.
