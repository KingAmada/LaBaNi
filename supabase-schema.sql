-- LaBaNi Supabase schema
-- Run this once in the Supabase SQL editor for project acqypknpiqxtavzjqhpo.

create table if not exists public.event_settings (
  event_code text primary key,
  original_entry_fee integer not null,
  discount_start_date timestamptz not null,
  starting_discount_percent integer not null,
  daily_discount_drop integer not null,
  additional_guest_discount_percent integer not null,
  original_vip_fee integer not null,
  total_vip_slots integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.resort_activities (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  activity_id text not null,
  display_order integer not null,
  name text not null,
  type text not null,
  img text not null,
  price integer not null,
  icon text not null,
  description text not null,
  keywords text not null,
  is_active boolean not null default true,
  primary key (event_code, activity_id)
);

create table if not exists public.hero_media (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  display_order integer not null,
  src text not null,
  hook text not null,
  alt text not null,
  keywords text not null,
  is_active boolean not null default true,
  primary key (event_code, display_order)
);

create table if not exists public.zone_slider_media (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  display_order integer not null,
  src text not null,
  label text not null,
  description text not null,
  keywords text not null,
  is_active boolean not null default true,
  primary key (event_code, display_order)
);

create table if not exists public.vip_perks (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  display_order integer not null,
  perk text not null,
  is_active boolean not null default true,
  primary key (event_code, display_order)
);

create table if not exists public.social_proof (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  display_order integer not null,
  message text not null,
  is_active boolean not null default true,
  primary key (event_code, display_order)
);

create table if not exists public.tickets (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  pass_id text primary key,
  guest_id text not null,
  guest_name text not null,
  phone text not null,
  is_vip boolean not null default false,
  paid boolean not null default true,
  zones jsonb not null default '[]'::jsonb,
  amount_paid integer not null default 0,
  issued_at timestamptz not null default now(),
  upgraded_at timestamptz
);

create table if not exists public.ticket_scans (
  event_code text not null references public.event_settings(event_code) on delete cascade,
  scan_id text primary key,
  pass_id text,
  guest_name text,
  zone_id text not null,
  zone_name text not null,
  status text not null check (status in ('permitted', 'denied')),
  repeat_entry boolean not null default false,
  moved boolean not null default false,
  previous_zone_id text,
  previous_zone_name text,
  reason text not null,
  scanned_at timestamptz not null default now()
);

alter table public.event_settings enable row level security;
alter table public.resort_activities enable row level security;
alter table public.hero_media enable row level security;
alter table public.zone_slider_media enable row level security;
alter table public.vip_perks enable row level security;
alter table public.social_proof enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_scans enable row level security;

drop policy if exists "public read event settings" on public.event_settings;
drop policy if exists "public read resort activities" on public.resort_activities;
drop policy if exists "public read hero media" on public.hero_media;
drop policy if exists "public read zone slider media" on public.zone_slider_media;
drop policy if exists "public read vip perks" on public.vip_perks;
drop policy if exists "public read social proof" on public.social_proof;
drop policy if exists "public read tickets" on public.tickets;
drop policy if exists "public write tickets" on public.tickets;
drop policy if exists "public read scans" on public.ticket_scans;
drop policy if exists "public write scans" on public.ticket_scans;

create policy "public read event settings" on public.event_settings for select using (true);
create policy "public read resort activities" on public.resort_activities for select using (is_active);
create policy "public read hero media" on public.hero_media for select using (is_active);
create policy "public read zone slider media" on public.zone_slider_media for select using (is_active);
create policy "public read vip perks" on public.vip_perks for select using (is_active);
create policy "public read social proof" on public.social_proof for select using (is_active);
create policy "public read tickets" on public.tickets for select using (true);
create policy "public write tickets" on public.tickets for all using (true) with check (true);
create policy "public read scans" on public.ticket_scans for select using (true);
create policy "public write scans" on public.ticket_scans for insert with check (true);

insert into public.event_settings (
  event_code,
  original_entry_fee,
  discount_start_date,
  starting_discount_percent,
  daily_discount_drop,
  additional_guest_discount_percent,
  original_vip_fee,
  total_vip_slots
) values (
  'LABANI-KINTIK-2026',
  100000,
  '2026-05-29T00:00:00+01:00',
  50,
  2,
  20,
  1000000,
  10
) on conflict (event_code) do update set
  original_entry_fee = excluded.original_entry_fee,
  discount_start_date = excluded.discount_start_date,
  starting_discount_percent = excluded.starting_discount_percent,
  daily_discount_drop = excluded.daily_discount_drop,
  additional_guest_discount_percent = excluded.additional_guest_discount_percent,
  original_vip_fee = excluded.original_vip_fee,
  total_vip_slots = excluded.total_vip_slots,
  updated_at = now();

insert into public.resort_activities (event_code, activity_id, display_order, name, type, img, price, icon, description, keywords) values
('LABANI-KINTIK-2026', 'a1', 1, 'Nightclub', 'Late Night Vibes', 'assets/red-lit-nightclub-vip-lounge Large.jpeg', 25000, 'music', 'Red-lit VIP nightclub lounge for LaBaNi 2026, built for rich Nigerian spenders, celebrity party energy, Afrobeats, highlife and late-night Naija vibes.', 'LaBaNi nightclub, VIP lounge, celebrity party, Naija nightlife, rich Nigerian party, Abuja exclusive party'),
('LABANI-KINTIK-2026', 'a2', 2, 'Pool Side', 'Wet & Wild', 'assets/pool-party-resort Large.jpeg', 20000, 'droplets', 'Premium resort pool party zone for LaBaNi 2026 with swimwear, cabana energy, Abuja party crowd and Last Born Association wet and wild vibes.', 'LaBaNi pool party, Abuja pool party, Naija resort party, VIP cabana, Last Born Association'),
('LABANI-KINTIK-2026', 'a3', 3, 'Playhouse', 'Games & Fun', 'assets/indoor-obstacle-play-area Large.jpeg', 10000, 'tent', 'Indoor obstacle playhouse and fun zone for LaBaNi guests, last born games, resort activities and playful premium Nigerian party moments.', 'LaBaNi playhouse, resort games, last born fun, Abuja party activities, Naija event games'),
('LABANI-KINTIK-2026', 'a5', 4, 'Lounge', 'Premium Chilling', 'assets/restaurant-lounge-dining Large.jpeg', 15000, 'glass-water', 'Premium LaBaNi lounge and dining zone for rich Naija chilling, bottle service, spenders, VIP conversations and Nigerian highlife ambience.', 'LaBaNi lounge, premium chilling, rich Nigerians, spenders, VIP dining, Abuja lounge party'),
('LABANI-KINTIK-2026', 'a6', 5, 'Karaoke Sit-out / Restaurant', 'Food & Vocals', 'assets/outdoor-patio-restaurant-crowd Large.jpeg', 5000, 'mic', 'Outdoor patio restaurant and karaoke sit-out for LaBaNi guests, food, vocals, grill energy, Naija highlife and social resort dining.', 'LaBaNi karaoke, restaurant sit-out, Naija food, highlife, Kintik grills, Abuja party restaurant'),
('LABANI-KINTIK-2026', 'a7', 6, 'Concert', 'Live Performances', 'assets/evening-labani-concert-stage Large.jpeg', 20000, 'party-popper', 'LaBaNi 2026 concert stage with VIP tables, celebrity-style performances, Abuja biggest party energy, Nigerian highlife and premium crowd scenes.', 'LaBaNi concert, biggest party in Abuja, celebrity party, Nigerian highlife, VIP tables, Last Born Association')
on conflict (event_code, activity_id) do update set
  display_order = excluded.display_order,
  name = excluded.name,
  type = excluded.type,
  img = excluded.img,
  price = excluded.price,
  icon = excluded.icon,
  description = excluded.description,
  keywords = excluded.keywords,
  is_active = true;

insert into public.hero_media (event_code, display_order, src, hook, alt, keywords) values
('LABANI-KINTIK-2026', 1, 'assets/trampoline-foam-pit-group Large.jpeg', 'Are you truly a last born if you’re not at LaBaNi?', 'LaBaNi 2026 playhouse foam pit group with Last Born Association party guests enjoying premium resort games.', 'LaBaNi, Last Born Association, playhouse, Naija party games'),
('LABANI-KINTIK-2026', 2, 'assets/trampoline-flip-foam-pit Large.jpeg', 'Last borns deserve the full experience. Not the stories.', 'Trampoline and foam pit action for LaBaNi 2026 guests, showing energetic Last Born Association fun before the big Abuja party.', 'LaBaNi 2026, trampoline, Abuja party, Last Born fun'),
('LABANI-KINTIK-2026', 3, 'assets/foam-pit-party-group Large.jpeg', 'Last borns were made to enjoy life. Stop suffering and enter.', 'LaBaNi foam pit party group posing inside the playhouse zone for rich Naija last borns and exclusive party guests.', 'LaBaNi party, last borns, Naija, exclusive party'),
('LABANI-KINTIK-2026', 4, 'assets/indoor-obstacle-play-area Large.jpeg', 'Are you the last born that gets treated or the one that gets left out?', 'Indoor obstacle play area at LaBaNi with guests, games and premium Last Born Association resort activity energy.', 'LaBaNi playhouse, obstacle zone, resort activities, Nigerian event'),
('LABANI-KINTIK-2026', 5, 'assets/resort-courtyard-party Large.jpeg', 'If you’re truly last born, your presence should be felt here.', 'Kintik Resort courtyard party scene for LaBaNi 2026 with Nigerian guests, dining, drinks and exclusive Abuja party energy.', 'Kintik Resort, LaBaNi Abuja, exclusive party, Nigerian crowd'),
('LABANI-KINTIK-2026', 6, 'assets/red-lit-nightclub-vip-lounge Large.jpeg', 'Secure your spot like the last born you are.', 'Red-lit LaBaNi nightclub VIP lounge for spenders, celebrity party guests, highlife lovers and Naija nightlife.', 'VIP lounge, LaBaNi nightclub, spenders, highlife, celebrity party'),
('LABANI-KINTIK-2026', 7, 'assets/pool-party-resort Large.jpeg', 'Are you truly a last born if you can’t afford this?', 'LaBaNi pool party resort scene with swimwear, premium cabana lifestyle and wet and wild Abuja party vibes.', 'LaBaNi pool party, Abuja pool party, rich Nigerian party, VIP cabana'),
('LABANI-KINTIK-2026', 8, 'assets/trampoline-fitness-class Large.jpeg', 'A last born always gets what they want. Are you?', 'Trampoline fitness party class for LaBaNi guests, adding playful Naija resort activities to the Last Born Association event.', 'trampoline party, LaBaNi activities, Last Born Association, Naija fun'),
('LABANI-KINTIK-2026', 9, 'assets/kintik-mirror-club-interior Large.jpeg', 'Last borns always go all out, they have backup, do you?', 'Kintik mirror club interior with LaBaNi guests, premium nightlife reflections and rich Nigerian party atmosphere.', 'Kintik club, LaBaNi nightlife, rich Nigerian, exclusive party'),
('LABANI-KINTIK-2026', 10, 'assets/restaurant-lounge-dining Large.jpeg', 'The resort is ready. The question is, are you?', 'LaBaNi restaurant lounge dining scene with VIP guests, Naija social energy and premium Abuja resort party setting.', 'LaBaNi lounge, restaurant, Abuja resort party, VIP dining')
on conflict (event_code, display_order) do update set src = excluded.src, hook = excluded.hook, alt = excluded.alt, keywords = excluded.keywords, is_active = true;

insert into public.zone_slider_media (event_code, display_order, src, label, description, keywords) values
('LABANI-KINTIK-2026', 1, 'assets/pool-party-resort Large.jpeg', 'Pool Side', 'Wet and wild resort energy with cabanas, swimwear and premium LaBaNi pool party vibes.', 'LaBaNi pool party, Abuja pool side, Kintik Resort cabana, premium Naija party'),
('LABANI-KINTIK-2026', 2, 'assets/indoor-obstacle-play-area Large.jpeg', 'Playhouse', 'Indoor games, obstacle fun and playful Last Born Association resort energy.', 'LaBaNi playhouse, indoor obstacle play area, last born games, Abuja party activities'),
('LABANI-KINTIK-2026', 3, 'assets/restaurant-lounge-dining Large.jpeg', 'Lounge', 'Premium dining, bottle service conversations and rich Naija lounge ambience.', 'LaBaNi lounge, restaurant lounge, VIP dining, Abuja premium chilling'),
('LABANI-KINTIK-2026', 4, 'assets/kintik-suya-grill-rotisserie Large.jpeg', 'Grill Party', 'Kintik suya, grills and outdoor food culture for guests who came hungry and ready.', 'Kintik suya grill, LaBaNi grill party, Nigerian food, Abuja resort party'),
('LABANI-KINTIK-2026', 5, 'assets/red-lit-nightclub-vip-lounge Large.jpeg', 'Nightclub', 'Red-lit VIP lounge, late night Afrobeats and celebrity-style spender energy.', 'LaBaNi nightclub, VIP lounge, Afrobeats party, Abuja nightlife'),
('LABANI-KINTIK-2026', 6, 'assets/outdoor-patio-restaurant-crowd Large.jpeg', 'Karaoke Sit-out', 'Outdoor patio restaurant, vocals, drinks and highlife social scenes.', 'LaBaNi karaoke, outdoor restaurant, highlife, Abuja sit-out'),
('LABANI-KINTIK-2026', 7, 'assets/evening-labani-concert-stage Large.jpeg', 'Concert', 'Live stage, VIP tables and the biggest LaBaNi performance moment.', 'LaBaNi concert, live stage, VIP tables, biggest party in Abuja')
on conflict (event_code, display_order) do update set src = excluded.src, label = excluded.label, description = excluded.description, keywords = excluded.keywords, is_active = true;

insert into public.vip_perks (event_code, display_order, perk) values
('LABANI-KINTIK-2026', 1, 'Unrestricted access to all 6 Resort Zones'),
('LABANI-KINTIK-2026', 2, 'Premium bottle service & bottomless drinks'),
('LABANI-KINTIK-2026', 3, 'Dedicated personal concierge for the night'),
('LABANI-KINTIK-2026', 4, 'Front row seating at the Live Concert'),
('LABANI-KINTIK-2026', 5, 'Skip-the-line privileges across the resort')
on conflict (event_code, display_order) do update set perk = excluded.perk, is_active = true;

insert into public.social_proof (event_code, display_order, message) values
('LABANI-KINTIK-2026', 1, 'Chief Emeka secured a VIP Slot!'),
('LABANI-KINTIK-2026', 2, '50+ last borns just joined the Pool Side.'),
('LABANI-KINTIK-2026', 3, 'Only 3 VIP Don slots remaining!'),
('LABANI-KINTIK-2026', 4, 'Amaka just paid ₦150k for her squad.')
on conflict (event_code, display_order) do update set message = excluded.message, is_active = true;
