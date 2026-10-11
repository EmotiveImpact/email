# Plugging Caleane in

How Caleane connects to the platform: its studios become businesses here, consultation bookings feed the flows, owners open the campaign studio from Caleane's sidebar, and its emails send through our SES instead of Resend. Every change below is in the Caleane repository; nothing in Caleane has been changed yet. File and line references are from Caleane's `main` as checked on 2026-10-11, under `app/`.

Caleane has no marketing of its own today, so there is nothing to switch off. Two things it lacks matter for marketing: clients have no marketing consent, and studios have no postal address. Both are covered below.

## What maps to what

| Caleane | Platform | Notes |
|---|---|---|
| Studio (`studios.id`) | Tenant, external id = studio id | Name carries over; time zone comes from booking settings |
| Client (`clients`) | Contact, `externalId` = client id | Sent with each booking, and once for existing clients |
| Consultation (`consultations`) | Appointment, `id` = consultation id | `start_at` and `end_at` are already exact times |
| `data.title` | `service` | |
| `data.payment.amountMinor` | `price` | Only for paid bookings |
| `eraseClient` | `contacts.erase` | Unsubscribes and bounces are kept |
| Notification email | `emails.send`, idempotency key = outbox id | A retry never sends twice |

| Caleane status | Platform status |
|---|---|
| `Booked` | `booked` |
| `Completed` | `completed` |
| `Cancelled` | `cancelled` |
| `No-show` | `no_show` |
| `Awaiting payment`, `Unpaid`, `Needs review` | not sent; a booking only counts once it is confirmed |

## Steps for you (once)

1. In the platform, Developers, **Add an app** called Caleane. Give it a **New key** and copy it (it is shown once).
2. Under the Caleane app, **Sites that can show the studio inside them**: add Caleane's address.
3. In Caleane's environment set `PLATFORM_API_KEY`, `PLATFORM_URL` (such as `https://app.<yourdomain>`) and `CALEANE_EMAIL_PROVIDER=platform`.
4. Each studio adds its postal address in the platform's Appearance settings before its first campaign. The platform will not send marketing without one (UK e-commerce rules and the US CAN-SPAM Act ask for one).
5. To use the **Ask for a review** flow, each studio adds its review page (Google, Facebook or similar) under Appearance, Review link. Caleane has no feedback email of its own, so this flow fills that gap.

## 1. The client for the API

Until the SDK is published, copy `packages/sdk/src/index.ts` and `browser.ts` from this repository into `app/platform/` (they are TypeScript; strip the types, or build them once with `tsc` and copy the `.js`). Or call the API with `fetch` directly: every call is JSON with `Authorization: Bearer <key>`.

```js
// app/platform-client.mjs
const base=process.env.PLATFORM_URL,key=process.env.PLATFORM_API_KEY;
export const platformReady=Boolean(base&&key);
export async function platform(method,path,body,headers={}){
 const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...headers},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(20_000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){const error=new Error(data.error?.message||`Platform returned ${response.status}.`);error.status=response.status;error.code=data.error?.code;throw error;}
 return data;
}
```

## 2. Keeping bookings in step

Caleane already calls `recordConsultation` whenever a booking is made, moved or cancelled online (`consultations.mjs:149` and `:232`). Desk changes go through `changeConsultation` (`consultations.mjs:193`) without it. The sync adds one line beside each, writing to a small table inside the same transaction; a timer sends what is waiting. Nothing waits on the network while a client books.

```js
// app/platform-sync.mjs
import {platform,platformReady} from './platform-client.mjs';

export function installPlatformSync(db){db.exec(`CREATE TABLE IF NOT EXISTS platform_sync(id INTEGER PRIMARY KEY AUTOINCREMENT,studio_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT);`);}

const STATUS={Booked:'booked',Completed:'completed',Cancelled:'cancelled','No-show':'no_show'};
const queue=(db,studioId,kind,body)=>{if(platformReady)db.prepare('INSERT INTO platform_sync(studio_id,kind,body) VALUES(?,?,?)').run(studioId,kind,JSON.stringify(body));};

/** Call inside the transaction that changed the booking. */
export function syncConsultation(db,studioId,consultationId){
 const row=db.prepare('SELECT * FROM consultations WHERE id=? AND studio_id=?').get(consultationId,studioId);
 if(!row||!STATUS[row.status])return;
 const data=JSON.parse(row.data),[firstName,...rest]=String(data.name||'').trim().split(/\s+/);
 queue(db,studioId,'appointment',{tenant:studioId,id:row.id,email:data.email,contactExternalId:data.clientId||undefined,firstName,lastName:rest.join(' ')||undefined,
  startsAt:row.start_at,endsAt:row.end_at,service:data.title,price:data.payment?.status==='paid'?data.payment.amountMinor:undefined,currency:data.payment?.currency,
  status:STATUS[row.status],bookedAt:row.created_at});
 if(typeof data.marketing==='boolean')queue(db,studioId,'contact',{tenant:studioId,email:data.email,externalId:data.clientId||undefined,consent:{marketing:data.marketing?'granted':'withdrawn',source:'caleane:booking-form'}});
}
export function syncErasure(db,studioId,client){queue(db,studioId,'erase',{tenant:studioId,externalId:client.id});queue(db,studioId,'erase',{tenant:studioId,email:client.email});}

let running=false;
export async function runPlatformSync(db){
 if(running||!platformReady)return;running=true;
 try{
  for(const job of db.prepare('SELECT * FROM platform_sync WHERE next_attempt<=? ORDER BY id LIMIT 100').all(Date.now())){
   try{
    const body=JSON.parse(job.body);
    if(job.kind==='appointment')await platform('PUT','/v1/appointments',body);
    if(job.kind==='contact')await platform('PUT','/v1/contacts',body);
    if(job.kind==='erase')await platform('POST','/v1/contacts/erase',body);
    db.prepare('DELETE FROM platform_sync WHERE id=?').run(job.id);
   }catch(error){
    // A studio the platform has not seen yet: create it, then try again on the next run.
    if(error.code==='tenant_not_found'){const studio=db.prepare('SELECT name FROM studios WHERE id=?').get(job.studio_id);if(studio)await platform('PUT',`/v1/tenants/${job.studio_id}`,{name:studio.name,timezone:bookingTimezone(db,job.studio_id)});}
    db.prepare('UPDATE platform_sync SET attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?').run(Date.now()+Math.min(60000*2**job.attempts,6*3600000),String(error.message),job.id);
   }
  }
 }finally{running=false;}
}
```

`bookingTimezone` is the `timezone` from `bookingSettings(db,studioId)` in `consultations.mjs`, defaulting to `Europe/London`.

The lines to add in Caleane:

| Where | Add |
|---|---|
| `consultations.mjs:149`, after `recordConsultation(...)` in `settleBooking` | `syncConsultation(db,studioId,row.id);` |
| `consultations.mjs:232`, after `recordConsultation(...)` in `manageBooking` | `syncConsultation(db,studio.id,row.id);` |
| `consultations.mjs:193`, inside the `transaction` in `changeConsultation`, after the `UPDATE` | `syncConsultation(db,studioId,row.id);` |
| `client-erasure.mjs:35`, inside `eraseClient`'s `transaction` | `syncErasure(db,studioId,client);` |
| `server.mjs`, where the database is opened | `installPlatformSync(db);` |
| `server.mjs:935`, next to the email timer | `const platformTimer=setInterval(()=>void runPlatformSync(db),15000);platformTimer.unref();` |

### Bringing in history

For bookings from before the switch-on, one script per studio sends them 500 at a time with `POST /v1/appointments/batch` (`{tenant, appointments:[…]}`, the same fields as above without `tenant`). It answers `{saved, errors:[{index,message}]}`; rows that fail are listed and the rest are kept.

## 3. Marketing consent

Caleane never asked clients about marketing, so the platform treats them as booking-only until they say yes. Booking confirmations and reminders still send; campaigns and flows skip them.

Add one optional box to the public booking form (`src/components/PublicBooking.jsx`): "Send me occasional news and offers from {studio}". In `bookConsultation` (`consultations.mjs:153`) keep it as `data.marketing=body.marketing===true;`. The sync above sends it with the time and source, which is what UK GDPR and PECR ask for. A studio can also bring in consent it already holds through the platform's Audience import.

## 4. Sending Caleane's emails through the platform

Caleane sends through `deliver({to,subject,text,idempotencyKey})`, made by `createResendDelivery` (`notifications.mjs:295`) and chosen at `server.mjs:932`. A platform version has the same shape plus the studio:

```js
// in notifications.mjs, next to createResendDelivery
export function createPlatformDelivery({ownTenant='caleane'}={}){
 return async({to,subject,text,idempotencyKey,studioId})=>{
  if(!/^[a-f0-9-]{36}$/.test(idempotencyKey))throw new Error('Invalid email delivery reference.');
  const email=await platform('POST','/v1/emails',{tenant:studioId||ownTenant,to:cleanEmail(to),subject,text,stream:'transactional'},{'Idempotency-Key':idempotencyKey});
  return {id:email.id};
 };
}
```

- Pass the studio at `notifications.mjs:276`: add `studioId:job.studio_id` to the `deliver` call.
- Account emails (sign-in links, password resets, from `accountSecurity.dispatchOne`) belong to no studio, so they go from Caleane's own business on the platform. Create it once with `PUT /v1/tenants/caleane` and `{ "name": "Caleane" }`.
- At `server.mjs:932`, choose it when `CALEANE_EMAIL_PROVIDER=platform`:

```js
else if(process.env.CALEANE_EMAIL_PROVIDER==='platform')deliver=createPlatformDelivery();
else deliver=createResendDelivery({apiKey:process.env.RESEND_API_KEY,from:process.env.RESEND_FROM});
```

The `CALEANE_EMAIL_ENABLED=1` switch and the `RESEND_*` check above it still apply; with the platform, only `PLATFORM_API_KEY` and `PLATFORM_URL` are needed. A retry after a timeout is safe, because the platform returns the first email for the same key.

## 5. The studio inside Caleane

A route makes a short-lived link for the owner; the page loads it in a frame. The link works once, within five minutes, and is tied to Caleane's address.

In `server.mjs`, among the studio routes after line 288 (where `studio`, `user` and `requireOwner` are set):

```js
if(route==='/api/email-studio'&&req.method==='POST'){
 requireOwner();if(!platformReady)fail(404,'Email is not connected.');
 return reply(200,await platform('POST','/v1/studio/sessions',{tenant:studio.id,origin,user:{id:user.id,name:user.name,email:user.email},page:'campaigns',theme:{accent:studio.accent}}));
}
```

Caleane's Content Security Policy only allows frames from itself (`server.mjs:120`). Add the platform's address to `frame-src`:

```js
const platformOrigin=process.env.PLATFORM_URL?' '+new URL(process.env.PLATFORM_URL).origin:'';
const appCSP=`default-src 'self'; ... frame-src 'self'${platformOrigin}; ...`;
```

In the sidebar (`src/components/aetheria/AdminSidebar.jsx:6`), add `['email','Email',Send]` to `ownerItems` (import `Send` from `lucide-react`), and `email:'Email'` to `sectionLabel` in `src/app.jsx:158`. Then in the view switch (`src/app.jsx:192`), `view==='email'&&owner?<EmailStudio studio={studio} request={request}/>:` with:

```jsx
import {mountStudio} from '../platform/browser.js';

export function EmailStudio({studio,request}){
 const ref=useRef(null);
 useEffect(()=>{
  let unmount=()=>{};
  const open=async()=>{unmount();const {url}=await request('/api/email-studio?studio='+studio.id,'POST',{});unmount=mountStudio(ref.current,url,{onEvent:e=>{if(e.type==='session-expired')open();}});};
  open();return()=>unmount();
 },[studio.id]);
 return <div ref={ref}/>;
}
```

## Checking it works

1. Book a consultation on a studio's public booking page and tick the news box. Within 15 seconds the client shows in the platform with consent from `caleane:booking-form`.
2. Open Email in Caleane's sidebar. The studio appears inside Caleane with that client.
3. Mark the consultation as completed in Caleane. The visit shows as completed on the client's page in the platform.
4. Erase a test client in Caleane. The client disappears from the platform; their past emails show as erased.
