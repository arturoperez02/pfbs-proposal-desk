-- Made-up test data only.
-- PFBS Proposal Desk — starting data. Run AFTER schema.sql, in the SQL Editor.
-- 1) You, as Owner. Add everyone else from the app's Team screen.
insert into public.team_members(email,name,role) values ('aperez@pfbuildingservices.com','Arturo','Owner') on conflict (email) do nothing;

insert into public.proposals(num,date_sent,sent_by,client,property,amount,status,date_resolved,hcp_job,notes,service,frequency,client_type,lead_source,gp,pass_through) values
('PFBS-0772','2026-07-05','Arturo','Acme Property Group','100 Test Plaza - Oakland',1500,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',675,0),
('PFBS-0773','2026-07-07','Arturo','Sample Realty','200 Demo St - San Jose',2230,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',1003,0),
('PFBS-0774','2026-07-09','Arturo','Example REIT','300 Mock Ave - Fremont',2960,'Approved','2026-07-10','10102','','Window Cleaning','One-time','New client','Referral',1332,0),
('PFBS-0775','2026-07-11','Arturo','Placeholder HOA','400 Fake Ln - Hayward',3690,'Scheduled','2026-07-12','10103','','Window Cleaning','One-time','New client','Referral',1660,0),
('PFBS-0776','2026-07-13','Arturo','Test Tower LLC','500 Example Blvd - SF',4420,'Invoiced','2026-07-14','10104','','Window Cleaning','One-time','New client','Referral',1989,0),
('PFBS-0777','2026-07-15','Arturo','Acme Property Group','100 Test Plaza - Oakland',5150,'Paid','2026-07-16','10105','','Window Cleaning','One-time','New client','Referral',2317,0),
('PFBS-0778','2026-07-17','Arturo','Sample Realty','200 Demo St - San Jose',5880,'Declined','2026-07-18','','','Window Cleaning','One-time','New client','Referral',2646,0),
('PFBS-0779','2026-07-19','Arturo','Example REIT','300 Mock Ave - Fremont',6610,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',2974,0),
('PFBS-0780','2026-07-21','Arturo','Placeholder HOA','400 Fake Ln - Hayward',7340,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',3303,0),
('PFBS-0781','2026-07-23','Arturo','Test Tower LLC','500 Example Blvd - SF',8070,'Withdrawn','2026-07-24','','','Window Cleaning','One-time','New client','Referral',3631,0),
('PFBS-0782','2026-08-05','Arturo','Acme Property Group','100 Test Plaza - Oakland',8800,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',3960,0),
('PFBS-0783','2026-08-07','Arturo','Sample Realty','200 Demo St - San Jose',9530,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',4288,0),
('PFBS-0784','2026-08-09','Arturo','Example REIT','300 Mock Ave - Fremont',10260,'Approved','2026-08-10','10112','','Window Cleaning','One-time','New client','Referral',4617,0),
('PFBS-0785','2026-08-11','Arturo','Placeholder HOA','400 Fake Ln - Hayward',10990,'Scheduled','2026-08-12','10113','','Window Cleaning','One-time','New client','Referral',4945,0),
('PFBS-0786','2026-08-13','Arturo','Test Tower LLC','500 Example Blvd - SF',11720,'Invoiced','2026-08-14','10114','','Window Cleaning','One-time','New client','Referral',5274,0),
('PFBS-0787','2026-08-15','Arturo','Acme Property Group','100 Test Plaza - Oakland',12450,'Paid','2026-08-16','10115','','Window Cleaning','One-time','New client','Referral',5602,0),
('PFBS-0788','2026-08-17','Arturo','Sample Realty','200 Demo St - San Jose',13180,'Declined','2026-08-18','','','Window Cleaning','One-time','New client','Referral',5931,0),
('PFBS-0789','2026-08-19','Arturo','Example REIT','300 Mock Ave - Fremont',13910,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',6259,0),
('PFBS-0790','2026-08-21','Arturo','Placeholder HOA','400 Fake Ln - Hayward',14640,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',6588,0),
('PFBS-0791','2026-08-23','Arturo','Test Tower LLC','500 Example Blvd - SF',15370,'Withdrawn','2026-08-24','','','Window Cleaning','One-time','New client','Referral',6916,0),
('PFBS-0792','2026-09-05','Arturo','Acme Property Group','100 Test Plaza - Oakland',16100,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',7245,0),
('PFBS-0793','2026-09-07','Arturo','Sample Realty','200 Demo St - San Jose',16830,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',7573,0),
('PFBS-0794','2026-09-09','Arturo','Example REIT','300 Mock Ave - Fremont',17560,'Approved','2026-09-10','10122','','Window Cleaning','One-time','New client','Referral',7902,0),
('PFBS-0795','2026-09-11','Arturo','Placeholder HOA','400 Fake Ln - Hayward',18290,'Scheduled','2026-09-12','10123','','Window Cleaning','One-time','New client','Referral',8230,0),
('PFBS-0796','2026-09-13','Arturo','Test Tower LLC','500 Example Blvd - SF',19020,'Invoiced','2026-09-14','10124','','Window Cleaning','One-time','New client','Referral',8559,0),
('PFBS-0797','2026-09-15','Arturo','Acme Property Group','100 Test Plaza - Oakland',19750,'Paid','2026-09-16','10125','','Window Cleaning','One-time','New client','Referral',8887,0),
('PFBS-0798','2026-09-17','Arturo','Sample Realty','200 Demo St - San Jose',20480,'Declined','2026-09-18','','','Window Cleaning','One-time','New client','Referral',9216,0),
('PFBS-0799','2026-09-19','Arturo','Example REIT','300 Mock Ave - Fremont',21210,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',9544,0),
('PFBS-0800','2026-09-21','Arturo','Placeholder HOA','400 Fake Ln - Hayward',21940,'Sent',null,'','','Window Cleaning','One-time','New client','Referral',9873,0),
('PFBS-0801','2026-09-23','Arturo','Test Tower LLC','500 Example Blvd - SF',22670,'Withdrawn','2026-09-24','','','Window Cleaning','One-time','New client','Referral',10201,0);

-- 3) Next new proposal gets PFBS-0802.
select setval('public.proposal_seq', 801);
