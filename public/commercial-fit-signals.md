# Commercial Fit Signals — Technical Architecture
## Agent Reference Document for Renewal Risk Scoring

---

## 1. Purpose

This document defines the **Commercial Fit Signals** component of the Renewal Risk Scoring model.
An AI Agent must read this document to:
1. Understand which commercial and account objects to query
2. Extract the correct commercial health fields
3. Compute sub-scores per signal
4. Aggregate into a final `commercial_fit_score` (0–100)
5. Map the score to a risk band and recommended action

The `commercial_fit_score` contributes **20%** of the overall Renewal Risk Score.

```
Overall Risk Score =
    (billing_health_score         × 30%) +
    (subscription_lifecycle_score × 25%) +
    (engagement_score             × 25%) +
    (commercial_fit_score         × 20%)
```

---

## 2. Platform Object Hierarchy

The Agent must query the following objects:

```
Account / Customer                (Level 1 — ACV, ARR, tier context)
    ├── Subscription / Asset      (Level 2 — license count, utilization)
    ├── Opportunity               (Level 2 — renewal opportunity, stage)
    └── AssetTransactionHistory   (Level 2 — discount trend, ARR changes)
```

---

## 2a. Architectural View

### 2a.1 — End-to-End System Architecture

```mermaid
flowchart TD
    subgraph PLATFORM["🏗️ Platform — Source of Truth"]
        ACC["Account\n──────────────\n• AnnualRevenue\n• Tier\n• ACV / ARR\n• NumberOfEmployees"]
        SUB["Subscription / Asset\n──────────────\n• LicenseCount\n• ActiveUserCount\n• NetUnitPrice\n• TotalARR\n• RenewalDate"]
        OPP["Opportunity\n──────────────\n• Stage\n• Amount\n• CloseDate\n• IsRenewal\n• Type"]
        ATH["AssetTransactionHistory\n──────────────\n• ChangeInAssetARR\n• ChangeInAssetTCV\n• Action (Downgrade)\n• TransactionDate"]
    end

    subgraph SIGNALS["⚡ Signal Extraction Layer"]
        S1["S1 — License Utilization\nActiveUserCount / LicenseCount\nMax: 30 pts"]
        S2["S2 — Renewal Proximity\nDays until renewal date\nMax: 25 pts"]
        S3["S3 — ARR Trend\nARR change over last 12m\nMax: 25 pts"]
        S4["S4 — Discount Pressure\nDiscount % vs. list price\nMax: 20 pts"]
    end

    subgraph SCORING["🧮 Scoring Engine"]
        AGG["Score Aggregator\n──────────────\ncommercial_fit_score =\nMIN(100, MAX(0,\n  S1+S2+S3+S4))"]
        BAND["Risk Band Classifier\n──────────────\n0–30   → 🟢 Low Risk\n31–55  → 🟡 Medium Risk\n56–75  → 🔴 High Risk\n76–100 → ⛔ Critical"]
    end

    subgraph OUTPUT["📤 Agent Output"]
        JSON["Structured JSON Response\n──────────────\n• commercial_fit_score\n• commercial_risk_band\n• commercial_contribution (×20%)\n• signal_breakdown\n• raw_signals"]
        OVERALL["Overall Risk Score\n──────────────\nbilling    × 30%\nlifecycle  × 25%\nengagement × 25%\ncommercial × 20%"]
    end

    ACC --> S1 & S2 & S3 & S4
    SUB --> S1 & S2
    OPP --> S2
    ATH --> S3 & S4

    S1 & S2 & S3 & S4 --> AGG
    AGG --> BAND
    AGG & BAND --> JSON
    JSON --> OVERALL
```

---

### 2a.2 — Platform Object Relationship Map

```mermaid
erDiagram
    ACCOUNT ||--o{ SUBSCRIPTION : "owns"
    ACCOUNT ||--o{ OPPORTUNITY : "has"
    SUBSCRIPTION ||--o{ ASSET_TRANSACTION_HISTORY : "tracks changes"

    ACCOUNT {
        string AccountId PK
        string Name
        string Tier
        decimal AnnualRevenue
        int NumberOfEmployees
        decimal ACV
        decimal TotalARR
    }

    SUBSCRIPTION {
        string SubscriptionId PK
        string AccountId FK
        int LicenseCount
        int ActiveUserCount
        decimal NetUnitPrice
        decimal TotalARR
        date RenewalDate
        string Status
    }

    OPPORTUNITY {
        string OpportunityId PK
        string AccountId FK
        string Stage
        decimal Amount
        date CloseDate
        boolean IsRenewal
        string Type
    }

    ASSET_TRANSACTION_HISTORY {
        string Id PK
        string AssetLineItem FK
        string Action
        date TransactionDate
        decimal ChangeInAssetARR
        decimal ChangeInAssetTCV
        decimal ChangeInAssetMRR
    }
```

---

### 2a.3 — Agent Execution Flow

```mermaid
flowchart TD
    START(["🤖 Agent Invoked\nINPUT: account_id / customer_id"])

    RESOLVE["Step 1 — Resolve Account Context\nSELECT ACV, ARR, Tier, LicenseCount\nFROM Account JOIN Subscription\nWHERE AccountId = :account_id"]

    PARALLEL["Step 2 — Run Signal Queries in Parallel"]

    Q1["Query S1\nLicense Utilization\n← Subscription.ActiveUserCount\n  / Subscription.LicenseCount"]
    Q2["Query S2\nRenewal Proximity\n← Subscription.RenewalDate\n  or Opportunity.CloseDate"]
    Q3["Query S3\nARR Trend\n← AssetTransactionHistory\n  ChangeInAssetARR last 12m"]
    Q4["Query S4\nDiscount Pressure\n← AssetTransactionHistory\n  discount % vs list price"]

    SCORE["Step 3 — Apply Scoring Thresholds\nS1: 0/8/18/30 pts\nS2: 0/8/15/25 pts\nS3: 0/10/18/25 pts\nS4: 0/5/12/20 pts"]

    AGGREGATE["Step 4 — Aggregate\ncommercial_fit_score =\nMIN(100, MAX(0, S1+S2+S3+S4))"]

    BAND{"Step 5 — Classify Risk Band"}

    LOW["🟢 Low Risk\n0–30\nMonitor, renew standard"]
    MED["🟡 Medium Risk\n31–55\nProactive renewal discussion"]
    HIGH["🔴 High Risk\n56–75\nSave offer, commercial review"]
    CRIT["⛔ Critical\n76–100\nImmediate exec intervention"]

    CONTRIB["Step 6 — Calculate Contribution\ncommercial_contribution =\ncommercial_fit_score × 0.20"]

    OUT["Step 7 — Return JSON\n{\n  commercial_fit_score,\n  commercial_risk_band,\n  commercial_contribution,\n  signal_breakdown,\n  raw_signals\n}"]

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
pie title Commercial Fit Score — Max Point Allocation (100 pts)
    "S1 License Utilization" : 30
    "S2 Renewal Proximity" : 25
    "S3 ARR Trend" : 25
    "S4 Discount Pressure" : 20
```

---

### 2a.5 — Risk Escalation Matrix

```mermaid
flowchart LR
    subgraph RISK_BANDS["Risk Band → Action"]
        direction TB
        LOW2["🟢 Low Risk\nScore 0–30\n─────────────\n✓ Standard renewal motion\n✓ Auto-renew eligible\n✓ Routine commercial review"]
        MED2["🟡 Medium Risk\nScore 31–55\n─────────────\n⚠ Early renewal conversation\n⚠ Right-size license discussion\n⚠ Value ROI reinforcement"]
        HIGH2["🔴 High Risk\nScore 56–75\n─────────────\n🚨 Save offer authorized\n🚨 Commercial terms reviewed\n🚨 CSM + Sales aligned"]
        CRIT2["⛔ Critical\nScore 76–100\n─────────────\n🔴 Immediate exec-to-exec\n🔴 Custom retention terms\n🔴 Churn impact quantified"]
    end

    LOW2 -->|"score rises"| MED2
    MED2 -->|"score rises"| HIGH2
    HIGH2 -->|"score rises"| CRIT2
    CRIT2 -->|"intervention works"| HIGH2
    HIGH2 -->|"save succeeds"| MED2
    MED2 -->|"health improves"| LOW2
```

---

## 3. Platform Object Definitions

### 3.1 Account / Customer
**Purpose:** Root commercial record — defines the account tier, ACV, and ARR baseline.

| Field | Data Type | Description | Churn Signal |
|---|---|---|---|
| `AccountId` | Identifier | Primary key | Join key |
| `Name` | String | Account name | Display |
| `Tier` | Picklist | Enterprise / Mid-Market / SMB | Tier-adjusted scoring |
| `AnnualRevenue` | Currency | Customer-reported annual revenue | ICP fit proxy |
| `ACV` | Currency | Annual Contract Value | Revenue at risk |
| `TotalARR` | Currency | Total Annual Recurring Revenue | Portfolio exposure |
| `NumberOfEmployees` | Integer | Employee count | ICP fit proxy |

---

### 3.2 Subscription / Asset
**Purpose:** Tracks the commercial subscription including license counts and renewal timing.

| Field | Data Type | Description | Churn Signal |
|---|---|---|---|
| `SubscriptionId` | Identifier | Primary key | Join key |
| `AccountId` | Lookup | Account FK | Parent link |
| `LicenseCount` | Integer | Total licenses purchased | Capacity baseline |
| `ActiveUserCount` | Integer | Currently active users | **Utilization signal** |
| `NetUnitPrice` | Currency | Price per unit after discount | Discount baseline |
| `TotalARR` | Currency | ARR for this subscription | Revenue baseline |
| `RenewalDate` | Date | Next renewal date | **Proximity signal** |
| `Status` | Picklist | Active / Pending / Churned | Filter to active |

---

### 3.3 Opportunity
**Purpose:** Tracks the renewal opportunity record in the CRM pipeline.

| Field | Data Type | Description | Churn Signal |
|---|---|---|---|
| `OpportunityId` | Identifier | Primary key | Join key |
| `AccountId` | Lookup | Account FK | Parent link |
| `Stage` | Picklist | Pipeline stage | Late stage = imminent |
| `Amount` | Currency | Expected renewal amount | ARR at stake |
| `CloseDate` | Date | Expected close / renewal date | **Proximity signal** |
| `IsRenewal` | Boolean | Whether this is a renewal opp | Filter flag |
| `Type` | Picklist | New / Renewal / Expansion | Renewal filter |

---

### 3.4 AssetTransactionHistory
**Purpose:** Tracks ARR changes, upgrades, downgrades, and discount history per asset.
(Full field definitions in `billing-financial-signals.md` Section 3.7)

Key fields used for commercial scoring:

| Field | Data Type | Description | Churn Signal |
|---|---|---|---|
| `Action` | Picklist | Upgrade / Downgrade / Renewal | Downgrade = risk |
| `TransactionDate` | Date | Date of commercial change | Recency filter |
| `ChangeInAssetARR` | Currency | ARR delta from this transaction | **ARR trend signal** |
| `ChangeInAssetTCV` | Currency | TCV delta | Contract shrinkage |

---

## 4. The Four Commercial Fit Signals

### Signal 1 — License Utilization
**Source:** `Subscription.ActiveUserCount`, `Subscription.LicenseCount`
**Description:** Under-utilized licenses indicate poor product fit or user abandonment. An account paying for 100 seats with only 20 active users has a high likelihood of right-sizing (i.e., reducing) at renewal.

| Threshold | Points Assigned |
|---|---|
| ≥ 80% license utilization | 0 |
| 60–79% license utilization | 8 |
| 40–59% license utilization | 18 |
| < 40% license utilization | 30 (capped) |

**Max contribution:** 30 points
**Query:**
```sql
SELECT
    LicenseCount,
    ActiveUserCount,
    CASE
        WHEN LicenseCount = 0 THEN NULL
        ELSE ROUND(ActiveUserCount::NUMERIC / LicenseCount * 100, 2)
    END AS utilization_pct
FROM Subscription
WHERE AccountId = :account_id
  AND Status = 'Active';
```

---

### Signal 2 — Renewal Proximity
**Source:** `Subscription.RenewalDate`, `Opportunity.CloseDate`
**Description:** The closer the renewal date, the higher the urgency. Accounts within 90 days of renewal with other negative signals are in the highest-priority intervention window.

| Threshold | Points Assigned |
|---|---|
| Renewal > 180 days away | 0 |
| Renewal 91–180 days away | 8 |
| Renewal 31–90 days away | 15 |
| Renewal ≤ 30 days away | 25 (capped) |

**Max contribution:** 25 points
**Query:**
```sql
SELECT
    RenewalDate,
    EXTRACT(DAY FROM RenewalDate::TIMESTAMPTZ - NOW())::INTEGER AS days_until_renewal
FROM Subscription
WHERE AccountId = :account_id
  AND Status = 'Active'
ORDER BY RenewalDate ASC
LIMIT 1;
```

---

### Signal 3 — ARR Trend (Last 12 Months)
**Source:** `AssetTransactionHistory.ChangeInAssetARR`, `AssetTransactionHistory.Action`
**Description:** Net ARR change over the last 12 months. Accounts that have shrunk their ARR through downgrades are materially more likely to churn or further reduce at the next renewal.

| Threshold | Points Assigned |
|---|---|
| ARR grew (positive `ChangeInAssetARR` net) | 0 |
| ARR flat (< 5% change) | 10 |
| ARR declined 5–20% | 18 |
| ARR declined > 20% | 25 (capped) |

**Max contribution:** 25 points
**Query:**
```sql
SELECT
    SUM(ChangeInAssetARR) FILTER (
        WHERE TransactionDate >= NOW() - INTERVAL '12 months'
    ) AS net_arr_change_12m,
    SUM(ChangeInAssetARR) FILTER (
        WHERE Action = 'Downgrade'
        AND TransactionDate >= NOW() - INTERVAL '12 months'
    ) AS arr_lost_to_downgrades_12m
FROM AssetTransactionHistory
WHERE AssetLineItem IN (
    SELECT Id FROM Asset WHERE AccountId = :account_id
);
```

---

### Signal 4 — Discount Pressure
**Source:** `AssetTransactionHistory`, `Subscription.NetUnitPrice`, list price comparison
**Description:** Accounts that received contractual discounts or have been granted incremental discounts during the prior renewal are at higher commercial risk. High-discount accounts have lower switching costs and more negotiating leverage.

| Threshold | Points Assigned |
|---|---|
| Discount ≤ 10% of list price | 0 |
| Discount 11–20% of list price | 5 |
| Discount 21–35% of list price | 12 |
| Discount > 35% of list price | 20 (capped) |

**Max contribution:** 20 points
**Query:**
```sql
-- Agent must compare NetUnitPrice to product list price
-- List price sourced from product catalog or PriceBookEntry
SELECT
    s.NetUnitPrice AS current_net_price,
    pb.UnitPrice AS list_price,
    CASE
        WHEN pb.UnitPrice = 0 THEN NULL
        ELSE ROUND((1 - s.NetUnitPrice / pb.UnitPrice) * 100, 2)
    END AS discount_pct
FROM Subscription s
JOIN PriceBookEntry pb ON s.Product2Id = pb.Product2Id
WHERE s.AccountId = :account_id
  AND s.Status = 'Active';
```

---

## 5. Score Formula

```
commercial_fit_score =
    MIN(100, MAX(0,
        license_utilization_points +
        renewal_proximity_points +
        arr_trend_points +
        discount_pressure_points
    ))
```

**Contribution to overall score:**
```
commercial_contribution = commercial_fit_score × 0.20
```

---

## 6. Structured JSON Output

The Agent must return the following JSON structure for the commercial component:

```json
{
  "commercial_fit_score": 48,
  "commercial_risk_band": "Medium Risk",
  "commercial_contribution": 9.6,
  "signal_breakdown": {
    "S1_license_utilization": {
      "points": 18,
      "raw": {
        "license_count": 100,
        "active_user_count": 47,
        "utilization_pct": 47.0
      }
    },
    "S2_renewal_proximity": {
      "points": 15,
      "raw": {
        "renewal_date": "2026-07-15",
        "days_until_renewal": 47
      }
    },
    "S3_arr_trend": {
      "points": 10,
      "raw": {
        "net_arr_change_12m": -1200.00,
        "arr_lost_to_downgrades_12m": -1200.00,
        "arr_change_pct": -3.5
      }
    },
    "S4_discount_pressure": {
      "points": 5,
      "raw": {
        "current_net_price": 449.00,
        "list_price": 500.00,
        "discount_pct": 10.2
      }
    }
  },
  "raw_signals": {
    "account_id": "ACC-00123",
    "account_tier": "Mid-Market",
    "total_arr": 34200.00,
    "acv": 34200.00
  }
}
```

---

## 7. Special Cases & Edge Handling

| Condition | Handling |
|---|---|
| `LicenseCount = 0` | Set `license_utilization_points = 30` (broken provisioning = risk) |
| `RenewalDate` is null or in the past | Set `renewal_proximity_points = 25` (overdue renewal = critical) |
| No `AssetTransactionHistory` rows in 12 months | Set `arr_trend_points = 0` (stable, no changes) |
| Discount percentage cannot be computed (no list price) | Set `discount_pressure_points = 5` (unknown = low-moderate risk) |
| Renewal opportunity in CRM is in `Closed Lost` stage | Add +15 bonus to `commercial_fit_score` before capping at 100 |
| Account tier = `Enterprise` AND `commercial_fit_score > 55` | Automatically escalate — set recommended action to CSM + AE joint review |
