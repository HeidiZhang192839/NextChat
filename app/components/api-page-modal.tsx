import Locale from "../locales";
import { ApiPageError } from "../utils/api-page";
import { showModal } from "./ui-lib";

export function showApiPageError(error: unknown) {
  if (!(error instanceof ApiPageError)) return false;

  const text = Locale.Error.ApiPage;
  showModal({
    title: text.Title,
    children: (
      <>
        <p>{error.challenge ? text.Challenge : text.Html}</p>
        <p>
          {!error.site
            ? text.CheckEndpoint
            : error.browserRequest
            ? text.VerifyAndRetry
            : text.ExternalRequest}
        </p>
        {error.site && (
          <a href={error.site} target="_blank" rel="noopener noreferrer">
            {text.OpenSite} ({error.site})
          </a>
        )}
      </>
    ),
  });
  return true;
}
