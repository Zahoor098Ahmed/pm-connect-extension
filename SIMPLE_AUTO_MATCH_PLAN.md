# PM Connect — Simple Auto-Match Plan (Developer ko Kuch Nahi Karna)

## Senior ki Feedback

Abhi tak jo tareeqa tha usme developer ko **login karna** padta tha aur **manually project se connect** karna padta tha. Senior ne kaha ke yeh tareeqa ziyada mushkil hai — developer ko bilkul kuch bhi nahi karna chahiye. Extension khud-ba-khud sab kuch pehchan le aur admin ko reports bhejta rahe.

Neeche wo simple flow hai jo senior chahte hain.

---

## Core Idea (1 line)

**Developer sirf VS Code khol ke normal coding kare.** Extension background mein khud current project ko Project Management (admin) ke database se **match** kar leta hai — na login, na "Connect" button, na manual step.

---

## Kaam Kaise Karega

### 1. Matching — Login/Connect ki Jagah

Har developer ke paas pehle se ek entry admin ke **Project Management system** mein hoti hai (admin khud add karta hai: developer ka naam/email + jo projects unko assign hain). Isi tarah har project ka bhi record hota hai (project name, folder/repo identifier).

Extension activate hote hi (koi button dabaye baghair) yeh 2 cheezein khud collect karta hai:
- **Developer identity** — machine/VS Code se already available cheez se (jaise Git config email `git config user.email`, ya OS username) — koi password/login form nahi.
- **Project identity** — current workspace folder ka naam + agar Git repo hai to uska remote URL.

Yeh dono cheezein background mein ek chhota `match` API call ke zariye admin ke server ko bhej deta hai:

```
POST /api/pmconnect.php?action=automatch
Body: { gitEmail, machineUsername, workspaceFolderName, gitRemoteUrl }
```

### 2. Server-Side Matching Logic

Admin ke Project Management database mein pehle se do tables hain: `developers` (ya `users`) aur `projects`. Server yeh karta hai:

1. `gitEmail` ya `machineUsername` ko `developers` table ke `email`/`username` column se match kare.
2. `gitRemoteUrl` (ya agar wo na ho to `workspaceFolderName`) ko `projects` table ke `repo_url`/`project_name` column se match kare.
3. Agar **dono match ho jayein** (yehi developer, yehi project, aur admin ne is developer ko is project pe assign kiya hua hai) — to server ek `project_id` + `developer_id` link wapas bhejta hai.
4. Extension yeh link chup-chaap save kar leta hai (local storage), aur ab se is workspace ke commits/activity isi `project_id` ke against log hote rahenge.

**Agar match na mile** (naya project jo admin ke system mein abhi register nahi, ya developer unrecognized) — extension bilkul silent rehta hai, koi error popup nahi, bas tracking start nahi hoti. Jab admin project management mein wo project/developer add kar dega, agli baar VS Code khulte hi khud match ho jayega.

> Is tarah "Connect" button ki zaroorat hi khatam ho jati hai — matching ek background handshake hai, login nahi.

### 3. Tracking (Jo Pehle se Plan Tha)

`AUTOMATIC_TRACKING_PLAN.md` mein jo already design hai wahi chalega:
- Commits aur active coding time silently log hote hain (`project_daily_log`, `project_commit_log`).
- Developer ko koi Start/Stop/Push button nahi dikhta.

### 4. Weekly + Monthly Auto Email (PDF) — Admin Ko

Backend (`C:\xampp\htdocs\projex`) mein do **cron jobs** (ya scheduled PHP script `wp-cron`/system cron):

- **Weekly cron** (e.g. har Monday 8 AM): har project ke liye pichle 7 din ka progress nikale (`rollup` API jaisi query) → PDF banaye → admin ke email pe bhej de.
- **Monthly cron** (mahine ke last din): pure mahine ka progress → PDF → admin ko email.

PDF mein: project name, developer name, is period mein kitne commits hue, kitna active time laga, daily breakdown table.

PDF generation ke liye halka library (jaise `dompdf` — pure PHP, koi extra server dependency nahi) use hoga; email `PHPMailer`/`mail()` se jayega attachment ke sath.

---

## Kya Naya Banana Hoga

**Extension side (`d:\pm-connect-extension`):**
- Purana "Connect to Project" command/UI hata dena (agar hai to).
- Activation pe silent `automatch` call add karna (git email + workspace info nikaal ke).
- Match response ko local state mein save karna, uske baad tracking wahi se continue.

**Backend side (`C:\xampp\htdocs\projex`):**
- Naya endpoint: `?action=automatch` (jo upar describe hua).
- `developers`/`projects` tables mein matching ke liye columns confirm karna (email, repo_url waghera already hain ya add karne parenge).
- Weekly + Monthly cron scripts (`cron/weekly-report.php`, `cron/monthly-report.php`) jo PDF banayein aur admin ko email karein.
- `dompdf` (ya similar) composer package add karna PDF ke liye.

---

## Login Ka Sawal — Clear Jawab

**Developer ko VS Code me kabhi bhi login nahi karna padega.** Automatch flow (upar) bas ek silent background handshake hai — git email/machine info se pehchan hoti hai, koi credentials maangi hi nahi jatin. Koi login screen, koi password field, kuch nahi.

---

## 5. Final Summary (Alag se, Daily Wale se Different)

Abhi jo **daily log** hai (`project_daily_log` — roz ka commits count + active time) wo **waisa hi rahega**, usme koi change nahi.

Naya add karna hai — **Final Summary**: jaise GitHub pe koi PR/commit close hote waqt ek comment banta hai jisme sara kaam summarize hota hai, waise hi is project (ya milestone/task) ke complete hone par ek **consolidated final summary** banni chahiye — sirf ek din ka nahi, balke us poore kaam ka jo hua:

- Kitne total commits hue, kitni active time lagi (start se end tak).
- Kya-kya kaam hua — commit messages se ek summarized list/description.
- Kab start hua, kab complete hua (`started_at` → `completed_at`).

**Kaise banega:** Jab admin project/task ko "Complete" mark kare (ya developer/extension khud kisi milestone completion trigger kare), backend `project_daily_log` + `project_commit_log` ke saare rows ko is project ke liye aggregate kare aur ek **final summary record** bana ke store kare (naya table, jaise `project_final_summary`: `project_id`, `total_commits`, `total_active_seconds`, `started_at`, `completed_at`, `summary_text`, `created_at`). Yeh Project Management website ke project detail page par dikhega, aur PDF report me bhi include hoga.

Daily rollup alag rehta hai (chhota, roz ka snapshot); final summary sirf completion ke waqt ek dafa banta hai (pura overview).

### Kisko Kya Jayega — Important Distinction

- **Daily summary** — sirf **internal/admin** ke liye hai. **Client ko kabhi nahi jayegi.** Yeh sirf project management ke andar dikhegi (admin apne liye track karne ke liye).
- **Final summary** — jab project/task complete ho, yeh **client ko bhi jayegi** (admin ke sath sath). GitHub comment jaisi clean, consolidated overview hone ki wajah se yeh client-facing hai — isliye ismein sirf high-level, presentable info honi chahiye (kya kaam hua, kab start/complete hua), koi internal/raw tracking detail (jaise exact active-seconds ya machine-level data) client-facing version me nahi jani chahiye.
- Isliye backend me do versions rakhne parenge: **internal final summary** (admin ke liye, pura detail) aur **client-facing final summary** (polished text, client email/PDF me jayega).

---

## 6. Developer Notification (Website Baar-Baar Check Na Karna Pade)

Jab bhi developer ka kaam (summary/progress) Project Management website me upload/update ho jaye — developer ko **VS Code ke andar hi ek notification** mil jani chahiye ("Aapka progress project management me update ho gaya hai — Project X, [date]"). Isse developer ko website khol ke check karne ki zaroorat nahi rahegi ke uska data gaya ya nahi.

**Kaise implement hoga:**
- Jab bhi developer ka **code push/commit** ho aur wo project management ke database me successfully save/update ho jaye (chahe daily log ho ya koi aur data), backend response me `{success: true, ...}` ke sath confirmation aaye.
- Extension VS Code ka native notification API use kare (`vscode.window.showInformationMessage`) — chhota, non-intrusive toast: "✅ Aapka code Project Management me update ho gaya — [Project Name]".
- Yeh trigger **push/commit ke waqt** ho (jab data actually backend me save ho), periodic polling se nahi — isliye har commit ke baad hi ek dafa notification aayega, spam nahi hoga.
- Agar kuch update hi nahi hua (network fail, ya duplicate/no-change), to notification bilkul nahi dikhana — sirf successful update par hi.

---

## Developer Experience (End Result)

1. Developer VS Code kholta hai, apna project folder open karta hai.
2. Extension chup-chaap match kar leta hai (agar admin ne pehle se assign kiya hua hai) aur tracking shuru ho jati hai.
3. Developer sirf normal code likhta rehta hai — koi login screen, koi connect button, kuch nahi dikhta.
4. Jab bhi progress/summary Project Management me update hoti hai, developer ko VS Code me chhota notification mil jata hai — website check karne ki zaroorat nahi.
5. Project/task complete hone par ek **final summary** ban jati hai (daily log se alag, GitHub-comment jaisi consolidated overview).
6. Admin ko har hafte aur har mahine khud-ba-khud email mein PDF progress report mil jati hai.

Yehi wo "zero-interaction" approach hai jo senior chahte hain.
