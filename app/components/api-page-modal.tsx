import Locale from "@/app/locales";
import { copyToClipboard } from "@/app/utils";
import { ApiPageError } from "@/app/utils/api-page";
import CopyIcon from "../icons/copy.svg";
import { IconButton } from "./button";
import { showModal } from "./ui-lib";
import styles from "./api-page-modal.module.scss";

export function showApiPageError(error: unknown) {
  if (!(error instanceof ApiPageError)) return false;

  const text = Locale.Error.ApiPage;
  showModal({
    title: text.Title,
    defaultMax: true,
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
        {error.body ? (
          <>
            <p>{text.Preview}</p>
            <iframe
              className={styles.preview}
              title={text.Preview}
              srcDoc={error.body}
              sandbox=""
              referrerPolicy="no-referrer"
            />
            <div className={styles.source}>
              <p>{text.Source}</p>
              <textarea
                aria-label={text.Source}
                readOnly
                value={error.body}
                rows={12}
                spellCheck={false}
              />
            </div>
          </>
        ) : (
          <p>{error.body === undefined ? text.ReadFailed : text.EmptyBody}</p>
        )}
      </>
    ),
    actions: [
      <IconButton
        key="copy-response"
        icon={<CopyIcon />}
        text={text.CopyResponse}
        aria={text.CopyResponse}
        onClick={() => copyToClipboard(error.body ?? "")}
      />,
    ],
  });
  return true;
}
