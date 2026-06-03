# Engagement Signals — Technical Architecture
## Agent Reference Document for Renewal Risk Scoring

---

## 1. Purpose

This document defines the **Engagement Signals** component of the Renewal Risk Scoring model.
An AI Agent must read this document together with `engagement-signals-erd.md` (which defines the CRM schema) to:
1. Understand which CRM objects to query
2. Extract the correct engagement fields
3. Compute sub-scores per signal
4. Aggregate into a final `engagement_score` (0–100)
5. Map the score to a risk band and recommended action

The `engagement_score` contributes **25%** of the overall Renewal Risk Score.

```
Overall Risk Score =
    (billing_health_score         × 30%) +
    (subscription_lifecycle_score × 25%) +
    (engagement_score             × 25%) +
    (commercial_fit_score         × 20%)
```

---

## 2. Platform Object Hierarchy

The Agent must query the following CRM objects (full schema defined in `engagement-signals-erd.md`):

```
Account                          (Level 1 — customer identity)
    ├── User                     (Level 2 — product login activity per seat)
    ├── SupportTicket            (Level 2 — support interactions per account)
    ├── NPSSurvey                (Level 2 — satisfaction scores per account)
    ├── ProductUsage             (Level 2 — feature-level usage logs per user)
    └── EngagementSignal         (Level 2 — pre-derived engagement signals)
```

---

## 2a. Architectural View

### 2a.1 — End-to-End System Architecture

```mermaid
flowchart TD
    subgraph PLATFORM["🏗️ CRM Platform — Source of Truth"]
        ACC["Account\n──────────────\n• AccountId\n• HealthScore\n• Tier\n• AnnualRevenue"]
        USR["User\n──────────────\n• LastLoginDate\n• LastActivityDate\n• IsActive\n• LoginCount\n• LicenseType"]
        ST["SupportTicket\n──────────────\n• CreatedDate\n• Status\n• Priority\n• Severity\n• ClosedDate"]
        NPS["NPSSurvey\n──────────────\n• Score\n• Sentiment\n• SurveyDate\n• SurveyType"]
        PU["ProductUsage\n──────────────\n• SessionCount\n• ActionCount\n• FeatureName\n• LastUsedDate\n• PeriodStart / End"]
        ES["EngagementSignal\n──────────────\n• SignalType\n• Severity\n• Score\n• DetectedDate\n• IsResolved"]
    end

    subgraph SIGNALS["⚡ Signal Extraction Layer"]
        S1["S1 — Support Ticket Volume\ntickets in last 90 days\nMax: 30 pts"]
        S2["S2 — User Activity / Last Login\ndays since any user login\nMax: 30 pts"]
        S3["S3 — NPS Score\nlatest NPS per account\nMax: 25 pts"]
        S4["S4 — Product Adoption Depth\nfeature usage breadth & trend\nMax: 15 pts"]
    end

    subgraph SCORING["🧮 Scoring Engine"]
        AGG["Score Aggregator\n──────────────\nengagement_score =\nMIN(100, MAX(0,\n  S1+S2+S3+S4))"]
        BAND["Risk Band Classifier\n──────────────\n0–30   → 🟢 Low Risk\n31–55  → 🟡 Medium Risk\n56–75  → 🔴 High Risk\n76–100 → ⛔ Critical"]
    end

    subgraph OUTPUT["📤 Agent Output"]
        JSON["Structured JSON Response\n──────────────\n• engagement_score\n• engagement_risk_band\n• engagement_contribution (×25%)\n• signal_breakdown\n• raw_signals"]
        OVERALL["Overall Risk Score\n──────────────\nbilling    × 30%\nlifecycle  × 25%\nengagement × 25%\ncommercial × 20%"]
    end

    ACC --> S1 & S2 & S3 & S4
    USR --> S2 & S4
    ST  --> S1
    NPS --> S3
    PU  --> S4
    ES  --> S1 & S2 & S3 & S4

    S1 & S2 & S3 & S4 --> AGG
    AGG --> BAND
    AGG & BAND --> JSON
    JSON --> OVERALL
```

---

### 2a.2 — Platform Object Relationship Map

See `engagement-signals-erd.md` for the full ERD. The key relationships used for scoring are:

```mermaid
erDiagram
    ACCOUNT ||--o{ USER : "has"
    ACCOUNT ||--o{ SUPPORT_TICKET : "raises"
    ACCOUNT ||--o{ NPS_SURVEY : "receives"
    USER ||--o{ PRODUCT_USAGE : "logs"
    ACCOUNT ||--o{ ENGAGEMENT_SIGNAL : "triggers"
```

---

### 2a.3 — Agent Execution Flow

```mermaid
flowchart TD
    START(["🤖 Agent Invoked\nINPUT: account_id"])

    RESOLVE["Step 1 — Resolve Account\nSELECT AccountId, HealthScore, Tier\nFROM Account\nWHERE AccountId = :account_id"]

    PARALLEL["Step 2 — Run Signal Queries in Parallel"]

    Q1["Query S1\nSupport Ticket Volume\n← SupportTicket.CreatedDate\n  last 90 days"]
    Q2["Query S2\nUser Activity\n← User.LastLoginDate\n  MAX across all seats"]
    Q3["Query S3\nNPS Score\n← NPSSurvey.Score\n  most recent per account"]
    Q4["Query S4\nProduct Adoption\n← ProductUsage.SessionCount\n  + FeatureName breadth"]

    SCORE["Step 3 — Apply Scoring Thresholds\nS1: 0/8/15/22/30 pts\nS2: 0/8/18/25/30 pts\nS3: 0/5/15/25 pts\nS4: 0/5/10/15 pts"]

    AGGREGATE["Step 4 — Aggregate\nengagement_score =\nMIN(100, MAX(0, S1+S2+S3+S4))"]

    BAND{"Step 5 — Classify Risk Band"}

    LOW["🟢 Low Risk\n0–30\nMonitor, routine check-in"]
    MED["🟡 Medium Risk\n31–55\nProactive outreach, value call"]
    HIGH["🔴 High Risk\n56–75\nCSM escalation, save offer"]
    CRIT["⛔ Critical\n76–100\nImmediate intervention"]

    CONTRIB["Step 6 — Calculate Contribution\nengagement_contribution =\nengagement_score × 0.25"]

    OUT["Step 7 — Return JSON\n{\n  engagement_score,\n  engagement_risk_band,\n  engagement_contribution,\n  signal_breakdown,\n  raw_signals\n}"]

    NEXT["Pass to Overall\nRisk Score Aggregator"]

    START --> RESOLVE
    RESOLVE --> PARALLEL
    PARALLEL --> Q1 & Q2 & Q3 & Q4
    Q1 & Q2 & Q3 & Q4 --> SCORE
    SCORE --> AGGREGATE
    AGGREGATE --> BAND
    BAND -->|"0–30"| LOW
    BAND -->|"31–55"| MED
    BAND -->|"56–75"| HIGH
    BAND -->|"76–100"| CRIT
    LOW & MED & HIGH & CRIT --> CONTRIB
    CONTRIB --> OUT
    OUT --> NEXT
```

---

### 2a.4 — Signal Contribution Breakdown (Visual Weight)

```mermaid
pie title Engagement Score — Max Point Allocation (100 pts)
    "S1 Support Ticket Volume" : 30
    "S2 User Activity / Last Login" : 30
    "S3 NPS Score" : 25
    "S4 Product Adoption Depth" : 15
```

---

### 2a.5 — Risk Escalation Matrix

```mermaid
flowchart LR
    subgraph RISK_BANDS["Risk Band → Action"]
        direction TB
        LOW2["🟢 Low Risk\nScore 0–30\n─────────────\n✓ Healthy engagement\n✓ Routine QBR cadence\n✓ Share product roadmap"]
        MED2["🟡 Medium Risk\nScore 31–55\n─────────────\n⚠ Proactive check-in\n⚠ Value reinforcement call\n⚠ Share adoption tips"]
        HIGH2["🔴 High Risk\nScore 56–75\n─────────────\n🚨 CSM escalation\n🚨 Executive sponsor engaged\n🚨 Save offer prepared"]
        CRIT2["⛔ Critical\nScore 76–100\n─────────────\n🔴 Immediate intervention\n🔴 Exec-to-exec outreach\n🔴 Retention offer deployed"]
    end

    LOW2 -->|"score rises"| MED2
    MED2 -->|"score rises"| HIGH2
    HIGH2 -->|"score rises"| CRIT2
    CRIT2 -->|"intervention works"| HIGH2
    HIGH2 -->|"save succeeds"| MED2
    MED2 -->|"health improves"| LOW2
```

---

## 3. The Four Engagement Signals

### Signal 1 — Support Ticket Volume (Last 90 Days)
**Source:** `SupportTicket.CreatedDate`, `SupportTicket.Priority`, `SupportTicket.Severity`
**Description:** High support ticket volume — especially high-severity tickets — is a strong indicator of product frustration and churn risk.

| Threshold | Points Assigned |
|---|---|
| 0–2 tickets in 90 days | 0 |
| 3–5 tickets in 90 days | 8 |
| 6–9 tickets in 90 days | 15 |
| 10–14 tickets in 90 days | 22 |
| 15+ tickets in 90 days | 30 (capped) |

**Severity Modifier:** If any open ticket has `Priority = 'Critical'` or `Severity = 'P1'`, add +5 bonus points (applied before cap).

**Max contribution:** 30 points
**Query:**
```sql
SELECT
    COUNT(*) FILTER (
        WHERE CreatedDate >= NOW() - INTERVAL '90 days'
    ) AS ticket_volume_90d,
    COUNT(*) FILTER (
        WHERE CreatedDate >= NOW() - INTERVAL '90 days'
        AND Status != 'Closed'
        AND (Priority = 'Critical' OR Severity = 'P1')
    ) AS open_critical_tickets
FROM SupportTicket
WHERE AccountId = :account_id;
```

---

### Signal 2 — User Activity / Last Login
**Source:** `User.LastLoginDate`, `User.IsActive`, `User.LastActivityDate`
**Description:** Days since the most recent login across all active seats. No recent logins is one of the strongest predictors of churn. An account where users have stopped logging in is effectively dark.

| Threshold | Points Assigned |
|---|---|
| Login within last 7 days | 0 |
| Login 8–14 days ago | 8 |
| Login 15–30 days ago | 18 |
| Login 31–60 days ago | 25 |
| No login in 60+ days (or no active users) | 30 (capped) |

**Max contribution:** 30 points
**Query:**
```sql
SELECT
    MAX(LastLoginDate) AS most_recent_login,
    EXTRACT(DAY FROM NOW() - MAX(LastLoginDate))::INTEGER AS days_since_last_login,
    COUNT(*) FILTER (WHERE IsActive = true) AS active_user_count,
    COUNT(*) FILTER (
        WHERE IsActive = true
        AND LastLoginDate >= NOW() - INTERVAL '30 days'
    ) AS active_users_last_30d
FROM "User"
WHERE AccountId = :account_id;
```

---

### Signal 3 — NPS Score
**Source:** `NPSSurvey.Score`, `NPSSurvey.SurveyDate`, `NPSSurvey.Sentiment`
**Description:** The most recent NPS score per account is a direct measure of customer satisfaction. Detractors (0–6) are at high churn risk. Missing NPS data is also a moderate risk signal.

| Threshold | Points Assigned |
|---|---|
| Promoter: NPS 9–10 | 0 |
| Passive: NPS 7–8 | 5 |
| Detractor: NPS 0–6 | 15 |
| Extreme Detractor: NPS 0–4 | 25 (replaces 15) |
| No NPS data available | 10 (unknown = moderate risk) |

**Max contribution:** 25 points
**Query:**
```sql
SELECT
    Score AS nps_score,
    Sentiment AS nps_sentiment,
    SurveyDate AS survey_date
FROM NPSSurvey
WHERE AccountId = :account_id
  AND SurveyDate IS NOT NULL
ORDER BY SurveyDate DESC
LIMIT 1;
```

---

### Signal 4 — Product Adoption Depth
**Source:** `ProductUsage.SessionCount`, `ProductUsage.FeatureName`, `ProductUsage.Module`, `ProductUsage.ActionCount`
**Description:** Breadth and depth of feature adoption. Accounts using only one or two features are less embedded and easier to churn. A month-over-month decline in session count is an early warning sign.

| Threshold | Points Assigned |
|---|---|
| 5+ distinct modules used in last 30 days, stable or growing usage | 0 |
| 3–4 distinct modules used, stable usage | 5 |
| 1–2 distinct modules used, or usage declining > 20% MoM | 10 |
| No product usage recorded in last 30 days | 15 (capped) |

**Max contribution:** 15 points
**Query:**
```sql
-- Current month adoption
SELECT
    COUNT(DISTINCT Module) AS distinct_modules_30d,
    SUM(SessionCount) AS total_sessions_30d,
    SUM(ActionCount) AS total_actions_30d
FROM ProductUsage
WHERE AccountId = :account_id
  AND PeriodStart >= NOW() - INTERVAL '30 days';

-- Prior month for trend
SELECT
    SUM(SessionCount) AS total_sessions_prior_30d
FROM ProductUsage
WHERE AccountId = :account_id
  AND PeriodStart >= NOW() - INTERVAL '60 days'
  AND PeriodEnd < NOW() - INTERVAL '30 days';
```

**MoM Decline Calculation:**
```
decline_pct = (total_sessions_prior_30d - total_sessions_30d) / NULLIF(total_sessions_prior_30d, 0) * 100
```

---

## 4. Score Formula

```
engagement_score =
    MIN(100, MAX(0,
        support_ticket_points +
        user_activity_points +
        nps_score_points +
        product_adoption_points
    ))
```

**Contribution to overall score:**
```
engagement_contribution = engagement_score × 0.25
```

---

## 5. Structured JSON Output

The Agent must return the following JSON structure for the engagement component:

```json
{
  "engagement_score": 62,
  "engagement_risk_band": "High Risk",
  "engagement_contribution": 15.5,
  "signal_breakdown": {
    "S1_support_ticket_volume": {
      "points": 22,
      "raw": {
        "ticket_volume_90d": 12,
        "open_critical_tickets": 1
      }
    },
    "S2_user_activity": {
      "points": 18,
      "raw": {
        "days_since_last_login": 22,
        "active_user_count": 8,
        "active_users_last_30d": 3
      }
    },
    "S3_nps_score": {
      "points": 15,
      "raw": {
        "nps_score": 5,
        "nps_sentiment": "Detractor",
        "survey_date": "2026-04-10"
      }
    },
    "S4_product_adoption": {
      "points": 7,
      "raw": {
        "distinct_modules_30d": 2,
        "total_sessions_30d": 45,
        "total_sessions_prior_30d": 80,
        "decline_pct": 43.75
      }
    }
  },
  "raw_signals": {
    "account_id": "ACC-00123",
    "health_score": "At Risk",
    "tier": "Enterprise"
  }
}
```

---

## 6. Special Cases & Edge Handling

| Condition | Handling |
|---|---|
| Account has no `User` records | Set `user_activity_points = 30` (maximum risk — no known users) |
| `NPSSurvey` table has no rows for account | Set `nps_score_points = 10` (unknown = moderate risk) |
| `ProductUsage` has no rows in last 60 days | Set `product_adoption_points = 15` (maximum adoption risk) |
| NPS survey older than 12 months | Treat as no data — set `nps_score_points = 10` |
| Active user count = 0 | Set `user_activity_points = 30` regardless of login timestamps |
| `EngagementSignal` table has an unresolved `CHAMPION_DEPARTURE` signal | Add +5 bonus to final `engagement_score` before capping at 100 |
