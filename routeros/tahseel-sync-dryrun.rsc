# Tahseel router sync - DRY-RUN, READ-ONLY. RouterOS 7.24+.
#
# What it does, every run:
#   A. asks the Tahseel server which usernames to look at;
#   B. reads those PPP secrets on THIS router (exists? off?) and sends the observations back.
# The server logs what it WOULD do. This script never changes anything on the router:
# its only menu commands are /ppp secret find + get, /system identity get and /tool fetch (output=user).
# routeros/scan.test.ts fails the test run if any other command ever appears in this file.
#
# Fill the four PASTE_ values ON THE ROUTER ONLY (see docs/ROUTER-SETUP.md). Never commit a filled copy.

:local tsProject "PASTE_PROJECT_REF"
:local tsKey "PASTE_ANON_KEY"
:local tsRouter "PASTE_ROUTER_ID"
:local tsToken "PASTE_ROUTER_TOKEN"

:if (($tsProject~"^PASTE_") or ($tsKey~"^PASTE_") or ($tsRouter~"^PASTE_") or ($tsToken~"^PASTE_")) do={
  :log error "tahseel: not configured - replace the PASTE_ values first"
  :error "tahseel: not configured"
}

:local tsUrl ("https://" . $tsProject . ".supabase.co/rest/v1/rpc/router_sync")
:local tsHdr ("Content-Type: application/json,apikey: " . $tsKey)
:local tsId [/system identity get name]

# One HTTPS POST to the server. The certificate is always verified.
:local tsCall do={
  :local body [:serialize to=json {"p_router_id"=$router; "p_token"=$token; "p_report"=$report}]
  :if ([:len $body] > 60000) do={ :error "tahseel: report too large" }
  :local res [/tool fetch url=$url http-method=post http-header-field=$hdr http-data=$body check-certificate=yes output=user as-value]
  :return [:deserialize from=json ($res->"data")]
}

# ---- A: which usernames to look at ----
:local tsRepA {"phase"="candidates"; "dry"=true; "identity"=$tsId}
:local tsA
:do {
  :set tsA [$tsCall url=$tsUrl hdr=$tsHdr router=$tsRouter token=$tsToken report=$tsRepA]
} on-error={
  :log error ("tahseel " . $tsRouter . ": call A failed (network, certificate, key or token)")
  :error "tahseel: call A failed"
}

:local tsCheck ($tsA->"check")
:log info ("tahseel " . $tsRouter . ": mode=" . ($tsA->"mode") . " gate=" . ($tsA->"gate") . " check=" . [:len $tsCheck])

:if ([:len $tsCheck] > 0) do={

  # ---- read only: does each name exist here, and is it off? ----
  :local tsObs [:toarray ""]
  :foreach u in=$tsCheck do={
    :local ids [/ppp secret find where name=$u]
    :if ([:len $ids] = 0) do={
      :set ($tsObs->[:len $tsObs]) {"u"=$u; "e"=false; "d"=false}
    } else={
      :local isOff [/ppp secret get ($ids->0) disabled]
      :set ($tsObs->[:len $tsObs]) {"u"=$u; "e"=true; "d"=$isOff}
    }
  }

  # ---- B: send the observations, log the verdicts ----
  :local tsRepB {"phase"="report"; "dry"=true; "identity"=$tsId; "obs"=$tsObs}
  :local tsB
  :do {
    :set tsB [$tsCall url=$tsUrl hdr=$tsHdr router=$tsRouter token=$tsToken report=$tsRepB]
  } on-error={
    :log error ("tahseel " . $tsRouter . ": call B failed (network, certificate, key, token or report size)")
    :error "tahseel: call B failed"
  }

  :local tsAct ($tsB->"actions")
  :if ([:len $tsAct] > 0) do={
    :log warning ("tahseel " . $tsRouter . ": server sent " . [:len $tsAct] . " actions - IGNORED, this script is read-only")
  }
  :local tsWould ($tsB->"would")
  :log info ("tahseel " . $tsRouter . ": DRY-RUN gate=" . ($tsB->"gate") . " batch=" . ($tsB->"batch") . " would=" . [:len $tsWould] . " - nothing was changed")
  :foreach w in=$tsWould do={
    :log info ("tahseel " . $tsRouter . ": would " . ($w->"action") . " " . ($w->"u") . " (" . ($w->"reason") . ")")
  }
}
