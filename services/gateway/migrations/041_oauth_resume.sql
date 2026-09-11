-- ONE CLICK ON "CONNECT" HAS TO DO BOTH HALVES OF A BLOCK CONNECTION.
--
-- A block door needs two credentials and they come from two different places: a ZZ platform
-- token, which the gateway mints, and the BLOCK's own delegated token, which only the block
-- can issue after its own consent screen. Both already existed; what did not was a way to run
-- them as one gesture.
--
-- So /oauth/authorize, when the resource is a block the person has not connected, sends them
-- to the block's own OAuth first and writes down which platform authorization to finish
-- afterwards. `/oauth/<block>/callback` — which already stores the delegated token — reads
-- this and, instead of printing its "Connected to casebox" page, redirects back to the front end
-- with the authorization code. The person sees one consent screen, at the block, which is the
-- only party with anything to ask them.
--
-- Null for a connection started from ZZ Access, which still ends at that page and should.
alter table zz.block_oauth_state
  add column if not exists resume_authz text;
