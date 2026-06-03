# Engagement Signals - CRM Schema ERD

## Entity Relationship Diagram

```mermaid
erDiagram
    Account {
        string AccountId PK
        string Name
        string Industry
        string Type
        string Status
        date CreatedDate
        string OwnerId FK
        decimal AnnualRevenue
        int NumberOfEmployees
        string HealthScore
        string Tier
    }

    Contact {
        string ContactId PK
        string AccountId FK
        string FirstName
        string LastName
        string Email
        string Phone
        string Role
        string Title
        boolean IsActive
        date LastActivityDate
        date CreatedDate
    }

    User {
        string UserId PK
        string ContactId FK
        string AccountId FK
        string Email
        boolean IsActive
        date LastLoginDate
        date LastActivityDate
        int LoginCount
        string LicenseType
        date CreatedDate
    }

    SupportTicket {
        string TicketId PK
        string AccountId FK
        string ContactId FK
        string Subject
        string Description
        string Status
        string Priority
        string Severity
        string Category
        date CreatedDate
        date ClosedDate
        date FirstResponseDate
        decimal ResolutionTimeHours
    }

    NPSSurvey {
        string SurveyId PK
        string AccountId FK
        string ContactId FK
        int Score
        string Feedback
        string Sentiment
        date SurveyDate
        string SurveyType
    }

    ProductUsage {
        string UsageId PK
        string UserId FK
        string AccountId FK
        string FeatureName
        string Module
        int SessionCount
        int ActionCount
        date LastUsedDate
        date PeriodStart
        date PeriodEnd
    }

    Opportunity {
        string OpportunityId PK
        string AccountId FK
        string Name
        string Stage
        decimal Amount
        date CloseDate
        string Type
        boolean IsRenewal
        date RenewalDate
    }

    Subscription {
        string SubscriptionId PK
        string AccountId FK
        string ProductName
        string Plan
        string Status
        date StartDate
        date EndDate
        date RenewalDate
        decimal MRR
        int LicenseCount
        int ActiveUserCount
    }

    EngagementSignal {
        string SignalId PK
        string AccountId FK
        string SignalType
        string Severity
        string Source
        string Description
        decimal Score
        date DetectedDate
        boolean IsResolved
    }

    Account ||--o{ Contact : "has"
    Account ||--o{ User : "has"
    Account ||--o{ SupportTicket : "raises"
    Account ||--o{ NPSSurvey : "receives"
    Account ||--o{ ProductUsage : "generates"
    Account ||--o{ Opportunity : "has"
    Account ||--o{ Subscription : "owns"
    Account ||--o{ EngagementSignal : "triggers"
    Contact ||--o{ SupportTicket : "opens"
    Contact ||--o{ NPSSurvey : "responds"
    Contact ||--o{ User : "maps to"
    User ||--o{ ProductUsage : "logs"
```

## Signal Derivation Logic

| Signal | Source Table | Key Fields | Logic |
|--------|-------------|------------|-------|
| Support ticket volume (high = dissatisfaction) | `SupportTicket` | `CreatedDate`, `Status`, `Severity` | Count tickets where `CreatedDate` > NOW - 90 days, grouped by `AccountId` |
| Last login / activity date | `User` | `LastLoginDate`, `IsActive` | Flag accounts where MAX(`LastLoginDate`) > X days ago |
| NPS score | `NPSSurvey` | `Score`, `SurveyDate` | Latest `Score` per account: 0-6 = Detractor, 7-8 = Passive, 9-10 = Promoter |
| Active user count from org | `User` | `IsActive`, `LastLoginDate`, `AccountId` | Count users where `IsActive = true` AND `LastLoginDate` within 30 days |
| Product adoption depth | `ProductUsage` | `SessionCount`, `FeatureName`, `Module` | Low/declining usage across features = churn risk |
| Renewal risk | `Subscription` | `RenewalDate`, `Status`, `MRR` | Combine with other negative signals near renewal window |

## EngagementSignal Types

| SignalType | Severity | Example |
|------------|----------|---------|
| `HIGH_TICKET_VOLUME` | High | >10 tickets in 90 days |
| `USER_INACTIVITY` | Medium | No login in 30+ days |
| `NPS_DETRACTOR` | High | NPS score 0-6 |
| `LOW_ADOPTION` | Medium | <20% feature usage |
| `DECLINING_USAGE` | Medium | 30%+ drop in sessions month-over-month |
| `RENEWAL_AT_RISK` | Critical | Renewal within 90 days + negative signals |
| `CHAMPION_DEPARTURE` | High | Key contact marked inactive |
| `LICENSE_UNDERUTILIZATION` | Low | ActiveUserCount < 50% of LicenseCount |
