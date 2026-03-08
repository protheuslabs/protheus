#!/usr/bin/env Rscript

options(warn = 1)

parse_arg <- function(args, key, default = NULL) {
  idx <- match(key, args)
  if (is.na(idx) || idx >= length(args)) {
    return(default)
  }
  args[[idx + 1]]
}

to_bool <- function(x) {
  if (isTRUE(x)) {
    "true"
  } else {
    "false"
  }
}

to_num <- function(x) {
  if (is.na(x) || is.nan(x) || is.infinite(x)) {
    return("0.0")
  }
  format(x, scientific = FALSE, trim = TRUE, digits = 12)
}

to_json_array <- function(values) {
  if (length(values) == 0) {
    return("[]")
  }
  paste0("[\"", paste(values, collapse = "\",\""), "\"]")
}

to_num_array <- function(values) {
  if (length(values) == 0) {
    return("[]")
  }
  paste0("[", paste(vapply(values, to_num, ""), collapse = ","), "]")
}

main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  cv_arg <- parse_arg(args, "--cv-sharpes", "")
  n_trials_arg <- parse_arg(args, "--n-trials", "1")
  min_deflated_arg <- parse_arg(args, "--min-deflated-sharpe", "0")
  max_pbo_arg <- parse_arg(args, "--max-pbo", "1")
  min_cv_sharpe_arg <- parse_arg(args, "--min-cv-sharpe", "0")
  bootstrap_arg <- parse_arg(args, "--bootstrap-samples", "2000")

  if (nchar(cv_arg) == 0) {
    stop("Missing required --cv-sharpes argument.")
  }

  cv_tokens <- unlist(strsplit(cv_arg, ",", fixed = TRUE))
  cv_sharpes <- as.numeric(cv_tokens)
  if (length(cv_sharpes) == 0 || any(is.na(cv_sharpes))) {
    stop("Unable to parse --cv-sharpes into numeric values.")
  }

  n_trials <- as.integer(n_trials_arg)
  if (is.na(n_trials) || n_trials < 1) {
    n_trials <- 1L
  }
  min_deflated <- as.numeric(min_deflated_arg)
  if (is.na(min_deflated)) {
    min_deflated <- 0.0
  }
  max_pbo <- as.numeric(max_pbo_arg)
  if (is.na(max_pbo)) {
    max_pbo <- 1.0
  }
  min_cv_sharpe <- as.numeric(min_cv_sharpe_arg)
  if (is.na(min_cv_sharpe)) {
    min_cv_sharpe <- 0.0
  }
  bootstrap_samples <- as.integer(bootstrap_arg)
  if (is.na(bootstrap_samples) || bootstrap_samples < 0) {
    bootstrap_samples <- 0L
  }

  cv_mean <- mean(cv_sharpes)
  cv_std <- if (length(cv_sharpes) > 1) stats::sd(cv_sharpes) else 0.0
  pbo_estimate <- mean(cv_sharpes <= 0.0)

  penalty <- if (n_trials > 1) sqrt(2.0 * log(as.numeric(n_trials))) / sqrt(252.0) else 0.0
  deflated_sharpe <- cv_mean - penalty

  if (length(cv_sharpes) > 1 && bootstrap_samples > 0) {
    set.seed(42)
    boot_means <- replicate(
      bootstrap_samples,
      mean(sample(cv_sharpes, size = length(cv_sharpes), replace = TRUE))
    )
    ci <- as.numeric(stats::quantile(boot_means, probs = c(0.025, 0.975), names = FALSE))
  } else {
    ci <- c(cv_mean, cv_mean)
  }

  reasons <- c()
  if (deflated_sharpe < min_deflated) {
    reasons <- c(reasons, "low_deflated_sharpe_r")
  }
  if (pbo_estimate > max_pbo) {
    reasons <- c(reasons, "high_pbo_r")
  }
  if (cv_mean < min_cv_sharpe) {
    reasons <- c(reasons, "low_cv_sharpe_r")
  }
  validator_passed <- length(reasons) == 0

  payload <- paste0(
    "{",
    "\"status\":\"ok\",",
    "\"validator_passed_r\":", to_bool(validator_passed), ",",
    "\"deflated_sharpe_r\":", to_num(deflated_sharpe), ",",
    "\"pbo_estimate_r\":", to_num(pbo_estimate), ",",
    "\"cv_sharpe_mean_r\":", to_num(cv_mean), ",",
    "\"cv_sharpe_std_r\":", to_num(cv_std), ",",
    "\"bootstrap_mean_ci\":", to_num_array(ci), ",",
    "\"reasons\":", to_json_array(reasons),
    "}"
  )
  cat(payload)
}

tryCatch(
  main(),
  error = function(err) {
    message(conditionMessage(err))
    quit(status = 2L)
  }
)
