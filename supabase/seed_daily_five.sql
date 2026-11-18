-- Run as the database owner. Replace the assigned date and all five prompts before running.
-- Example: a job on November 18 Eastern would assign November 19, not November 18.
begin;
insert into public.daily_challenges(challenge_date) values('2026-11-19');
insert into public.daily_questions(challenge_date,position,question) values
('2026-11-19',1,'Why might bringing shampoo to a job interview be a good idea?'),
('2026-11-19',2,'You can only keep one season forever. Which one would help a city thrive most, and why?'),
('2026-11-19',3,'A library decides to charge people for returning books early. What problem could that possibly solve?'),
('2026-11-19',4,'Why would a restaurant intentionally remove all of its clocks?'),
('2026-11-19',5,'What is the strongest argument for making every meeting standing-room only?');
update public.daily_challenges set published=true where challenge_date='2026-11-19';
commit;
