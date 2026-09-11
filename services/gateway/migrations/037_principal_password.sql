-- The second door on a principal, closed by default.
--
-- A password verifier stored on the principal itself: something a person types, that this
-- database can check without ever holding what they typed.
--
-- SCRYPT, NOT A ROUND COUNT ALONE. The stored string carries its own parameters (N, r, p)
-- alongside the salt and key, so a future migration to stronger parameters does not have to
-- rewrite every row at once — old rows keep verifying under the parameters they were written
-- with.
--
-- NULL IS THE DEFAULT AND THE SAFE STATE. Adding the column does not open a door for anyone
-- who has a row today; it only gives a future, explicit act — an authenticated principal
-- setting their own password, or an admin issuing one — somewhere to write. Nothing yet
-- reads this column to authenticate a request.
alter table zz.principal add column if not exists password_verifier text;
comment on column zz.principal.password_verifier is
  'scrypt, stored as scrypt$N$r$p$<base64 salt>$<base64 key>. Null means the password door is
   closed for this person; only an explicit act by an authenticated actor ever sets it.';
